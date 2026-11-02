# 祭坛之龙（Altar Dragon）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把用户提供的 Blockbench 紫水晶龙模型导入游戏，让它在全世界唯一带祭坛的高台地带上空盘旋，可被玩家武器与炮塔击中、有血量、红闪、死亡后永久消失。

**Architecture:** 素材经离线烘焙（`npm run dragon`）成「骨骼层级 + 合并几何 + 重采样动画帧」三件套产物；运行时用 **SkinnedMesh 单几何**（已实测 WebGPU 后端蒙皮可用）发布成 1 个 draw call。龙是 **EntityManager 的临时实体**（`persistent: false`），位置每帧由纯函数从 seed + 时间派生（红线 2：不进存档）；死亡标记写既有 `meta` 行的 `dragonDead` 字段。伤害路由在 **Game 装配层**按实体类型分发（不给 M5 EntityManager 加玩法接口）。

**Tech Stack:** 纯 JavaScript ES2022 + JSDoc（无 TS、无 bundler）；three.js r185.1 WebGPU 后端（本地 `vendor/three/`）；Node 侧烘焙脚本（`node:fs` + `pngjs`）；Playwright Tier 4 像素实测。

**Spec:** `docs/superpowers/specs/2026-11-03-altar-dragon-design.md`

## Global Constraints

- **红线 1**：同一事实只有一份权威。龙的数值权威 = `src/entities/dragons/dragon-config.js`；烘焙参数权威 = `tools/dragon-fingerprint.mjs`；产物几何/动画权威 = `assets/dragon/dragon.json`。渲染层与单测都从这些派生，不写字面量。
- **红线 2**：世界内容由 seed 确定性生成。龙的位置**不进存档**（临时实体 + 纯函数轨道）；只有 `dragonDead` 布尔标记进 `meta` 行。
- **红线 3**：主线程每帧只做输入/物理/调度/上传/渲染。龙的全部计算是每帧 O(1)（33 骨骼插值），不进 GEN/MESH/LIGHT。
- **红线 6**：实体命中唯一真相 = `EntityManager.raycast()` → `dragonDefinition.raycastAabb`。**禁止** `THREE.Raycaster` / `intersectObjects`。
- **红线 8/10**：`src/entities/**` 是同构层，**不得 import three、不得 import DOM、不得新建 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。`src/render/**` 可用 three。
- **资源路径**：一律走 `resourceUrl('assets/dragon/...')`（v1.87 约束）。**禁止**站点根绝对路径字面量（`'/assets/`、`'/src/`、`'/vendor/`）—— `check:arch` 的 `[资源 URL]` 环节零白名单挂掉式拦截。
- **命名禁令**：变量名/注释里不得出现 `RegionCache`、`safeBounds` 等 `FORBIDDEN_NAMES` 子串（`check:arch` 子串匹配，加白名单会削弱整条红线门）。
- **时间基准**：一律 `performance.now()`，禁止 `Date.now()`（两者相差约 17 亿毫秒，红闪判定会恒真）。
- **scale = 3**：烘焙产物已含 3 倍（px→格换算 `÷16×3`），运行时**不再乘**。`DRAGON.scale` 与产物 `metrics.scale` 由 `check:data` 双向钉住。
- **门禁分层**（testing-policy §6）：Tier 1（纯函数/机制）必须 TDD；Tier 2（数据契约）门禁断言免 TDD 流程；Tier 4（GPU 渲染）必须像素实测，**不宣称目视**。
- **提交纪律**：每个 Task 结束提交一次，Conventional Commits。**不加 `--no-verify`**。

## Review Focus

spec 隐含、但最可能咬到玩家的五类失效（每条都在 owning task 里加了对应测试）：

1. **面名→three 面序映射错**（`east/west/up/down/south/north` → `+x/−x/+y/−y/+z/−z`）：贴图会错位到邻面，龙头的眼睛跑到侧面/顶面。格数、指纹、单测全绿——只有像素能抓。→ Task 7 的 Tier 4 用例 ①（眼睛位置断言）。
2. **UV 的 v 轴 flipY 漏做**：整套贴图上下颠倒（AGENTS.md 已记该坑两次：丧尸皮肤 v2.38）。⚠️ 调试探针**必须走 `TextureLoader` 真实路径**，`DataTexture` 默认 `flipY=false` 会给出「方向正确」的假结论。→ Task 1 的产物契约（v 范围）+ Task 7 的 Tier 4 用例 ①。
3. **catmullrom 重采样实现错**：动画抽搐或僵硬，而帧数/指纹全对。→ Task 2 的「首末帧闭合」+「采样值落在关键帧值域内」两条断言。
4. **临时实体被 column 卸载回收后不重生**：玩家走远再回来，龙永久消失（而 `dragonDead` 并没写）——形态与「永久死亡」无法区分。→ Task 5 的 `ensure()` 重生用例 + Task 8 的 E2E 用例 ⑤。
5. **`computeTurretUpdates` 的 `zombies` → `targets` 改名后丧尸索敌静默失效**：既有 `test-turrets.js` 若只改参数名不改断言，会假绿。→ Task 6 的「丧尸索敌逐位零回归」用例（钉住改名后的 yaw/pitch/hasTarget/targetId 实测值，**断言一字不动**）。

---

### Task 1: 素材入库 + 烘焙脚本（骨骼 / 几何 / UV / 贴图）

**Tier:** 2（数据契约）—— 免 TDD 流程，但产物契约断言必须先行写进 `check:data`（Task 3 补门禁环节，本任务先用一次性脚本验证）。

**Files:**
- Create: `assets/dragon/src/amethyst_dragon.bbmodel`（从 `/Users/bachi/Downloads/Dragon/` 复制，**入库**：烘焙输入，非渲染资源）
- Create: `tools/dragon-fingerprint.mjs`（烘焙参数 + 输入指纹的**唯一权威**，node 侧）
- Create: `tools/bake-dragon.mjs`（`npm run dragon`）
- Create: `assets/dragon/dragon.json` / `assets/dragon/dragon.png` / `assets/dragon/dragon.meta.json`（产物，入库）
- Modify: `package.json`（加 `"dragon": "node tools/bake-dragon.mjs"`）

**Interfaces:**
- Consumes: 无（本任务是管线起点）
- Produces:
  - `tools/dragon-fingerprint.mjs` 导出：
    - `DRAGON_SOURCE_PATH: string`（`assets/dragon/src/amethyst_dragon.bbmodel` 绝对路径）
    - `DRAGON_JSON / DRAGON_PNG / DRAGON_META: string`（三个产物绝对路径）
    - `DRAGON_BAKE_PARAMS: Readonly<{scale: 3, textureSize: 128, pxPerBlock: 16, faceMap: Readonly<Record<string,string>>}>`
    - `DRAGON_METRICS: Readonly<{elementCount: 115, boneCount: 78, vertexCount: 2760, indexCount: 4140, scale: 3}>`
    - `dragonInputFingerprint(): string`（bbmodel sha256 + 参数 sha256，`<a>:<b>` 形式，与 `arena-fingerprint.mjs` 同手法）
  - `assets/dragon/dragon.json` 形状（**Task 2 会往 `animations` 里加内容，本任务先写空对象**）：
    ```js
    {
      scale: 3,
      bones: [{ name: string, parentIndex: number /* -1 = 根 */,
                localPosition: [number,number,number] /* 格，已含 scale */,
                bindQuaternion: [number,number,number,number] /* [x,y,z,w] */ }],  // 78 项，outliner 序
      geometry: {
        position: number[],   // 2760*3，格，模型空间（已含 scale，y 向上）
        normal:   number[],   // 2760*3
        uv:       number[],   // 2760*2，∈[0,1]
        skinIndex:number[],   // 2760*4（每顶点只用第 0 个，其余 0）
        index:    number[],   // 4140
      },
      animations: {},         // Task 2 填
      metrics: { elementCount:115, boneCount:78, vertexCount:2760, indexCount:4140, scale:3 },
    }
    ```
  - `assets/dragon/dragon.meta.json`：`{ fingerprints: { input, bbmodelSha256, paramsSha256 }, metrics: {...} }`

- [ ] **Step 1: 素材入库**

```bash
mkdir -p assets/dragon/src
cp /Users/bachi/Downloads/Dragon/amethyst_dragon.bbmodel assets/dragon/src/
```

⚠️ 只复制**不带鞍**的那个（用户裁定）。`assets/dragon/src/` 不在 `assets/textures/` 下 → 不会被 `build-atlas` 递归扫描（AGENTS.md 已记该坑）。

- [ ] **Step 2: 写 `tools/dragon-fingerprint.mjs`**

照 `tools/arena-fingerprint.mjs` 的结构：`ROOT = path.resolve(import.meta.dirname, '..')`，导出上面 Produces 列的全部常量与 `dragonInputFingerprint()`。

`faceMap` 的**确切值**（Blockbench/MC 面名 → three BoxGeometry 面序，spec §4.1）：

```js
faceMap: Object.freeze({
  east: '+x', west: '-x', up: '+y', down: '-y', south: '+z', north: '-z',
}),
```

文件头注释必须写明：⚠️ node 侧模块（依赖 `node:fs`），**`src/**` 与浏览器单测绝不能 import 它**（浏览器无法解析 `node:` 协议 → 模块不加载 → 游戏白屏，而 `check:arch` 抓不到这类运行时解析失败）。

- [ ] **Step 3: 写 `tools/bake-dragon.mjs` 的骨骼解析**

读 `.bbmodel`（`JSON.parse`），遍历 `outliner` 建骨骼表：

- `origin` 是**绝对模型空间坐标（px）** → `localPosition = (origin − parentOrigin) × scale ÷ pxPerBlock`；根骨骼的 parentOrigin = `[0,0,0]`。
- `bindQuaternion` 从骨骼的 `rotation`（度，Blockbench 顺序 `[x,y,z]`）构造：three `Euler(rx,ry,rz,'XYZ')` → `Quaternion`。**注意 Blockbench 的旋转是度、three 是弧度**。
- `parentIndex` = 父骨骼在数组里的下标（根为 `-1`）。
- 断言 `bones.length === DRAGON_METRICS.boneCount`（78），否则 throw。

- [ ] **Step 4: 写几何合并**

对每个 element（115 个，全是 `cube` + `box_uv` + 自身 `rotation` 全 0）：

- 8 个角 → 24 顶点（每面独立 4 顶点，法线不共享），面序按 three BoxGeometry：`[+x, −x, +y, −y, +z, −z]`，每面顶点序与 three 一致（保证法线朝外）。
- 位置：`from`/`to` 的 px → 格 = `× scale ÷ pxPerBlock`。**模型空间原样**（不居中、不平移）——骨骼的 `localPosition` 已是同一空间。
- UV：取该 element 的 `faces[面名].uv`（px，`[u1,v1,u2,v2]`）→ `÷ textureSize`。
  ⚠️ **保留递减书写**（如 chest 的 up 面 `[22,10,10,0]` u1>u0）—— 规范化成 min/max 会让那些面**水平镜像**（AGENTS.md 已记 MC 皮肤版式同一陷阱）。
  ⚠️ **v 轴翻转**：`v_three = 1 − v_px ÷ textureSize`（纹理走 `TextureLoader`，默认 `flipY = true`）。
- `skinIndex`：该 element 所属骨骼下标写进 `[i*4]`，其余三个填 0；`skinWeight` 运行时恒 1（**不存进产物**，渲染层生成）。
- 未知面名 / 非 `cube` 类型 / 无骨骼归属 → **throw**（静默丢弃会让产物看起来正常、实际缺肉，同竞技场烘焙口径）。

- [ ] **Step 5: 导出贴图**

`textures[0].source` 是 `data:image/png;base64,...` → 解码写 `assets/dragon/dragon.png`。断言尺寸 = `textureSize`（128×128），否则 throw。

- [ ] **Step 6: 写产物 + meta**

`dragon.json`（`animations: {}` 占位）+ `dragon.meta.json`（`dragonInputFingerprint()` 的结果 + metrics）。

- [ ] **Step 7: 加 npm script 并跑烘焙**

`package.json` 的 `scripts` 加 `"dragon": "node tools/bake-dragon.mjs"`（放在 `zombieskin` 之后）。

Run: `npm run dragon`
Expected: 无异常退出，`assets/dragon/` 下出现三个产物。

- [ ] **Step 8: 用一次性脚本验证产物契约（本任务的 RED/GREEN 判据）**

写 `/tmp/verify-dragon.mjs`（**放 /tmp，不入库**）断言：

```js
// 骨骼
assert(d.bones.length === 78);
assert(d.bones[0].name === 'root' && d.bones[0].parentIndex === -1);
assert(d.bones.every(b => Number.isFinite(b.localPosition.reduce((s,v)=>s+v,0))));
// 几何
assert(d.geometry.position.length === 2760 * 3);
assert(d.geometry.index.length === 4140);
assert(d.geometry.uv.every(v => v >= 0 && v <= 1));          // UV 在图内
assert(new Set(d.geometry.skinIndex.filter((_,i)=>i%4===0)).size === 76);  // 76 根骨骼带元素（spec §2.1 实测）
// 度量：模型空间 bbox 应 ≈ 16.5 × 6.3 × 18.75 格（spec §2.1）
const bb = axis => { const a=d.geometry.position.filter((_,i)=>i%3===axis); return [Math.min(...a), Math.max(...a)]; };
// x: [-8.25, 8.25]  y: [-0.32, 6.0]  z: [-7.31, 11.44]（容差 0.01）
// scale
assert(d.scale === 3 && d.metrics.scale === 3);
```

Run: `node /tmp/verify-dragon.mjs`
Expected: 全部断言通过。⚠️ **bbox 的实际值先打印再写断言**（AGENTS.md：写断言前必须先在真实数据上跑一次、打印实际值）。

- [ ] **Step 9: 跑最小门 + 提交**

```bash
npm run check
git add assets/dragon tools/dragon-fingerprint.mjs tools/bake-dragon.mjs package.json
git commit -m "feat(dragon): 紫水晶龙素材入库与烘焙（骨骼/几何/UV/贴图）"
```

Expected: `check:arch` + `check:data` + `lint` 全绿（`[龙]` 门禁环节在 Task 3 才加，此时 check:data 不认识产物，不会报错）。

---

### Task 2: 烘焙动画重采样（catmullrom → 30fps 帧序列）

**Tier:** 1（纯函数算法）—— 采样与插值是机制，必须 TDD。

**Files:**
- Modify: `tools/bake-dragon.mjs`（加动画重采样段）
- Modify: `tools/dragon-fingerprint.mjs`（`DRAGON_BAKE_PARAMS` 加 `animFps: 30`、`animations: ['fly','glide']`；`DRAGON_METRICS` 加 `flyFrameCount: 36`、`glideFrameCount: 90`）
- Modify: `assets/dragon/dragon.json`（重烘后 `animations` 有内容）
- Test: `src/tests/test-dragon-bake.js`（浏览器内单测，读产物 fetch；**须在 `src/tests/index.html` 注册**）

**Interfaces:**
- Consumes: Task 1 的 `dragon.json`（`bones` 数组，用于把动画的骨骼名映射成下标）
- Produces: `dragon.json` 的 `animations` 形状：
  ```js
  animations: {
    fly:   { fps: 30, frameCount: 36, boneIndices: number[] /* 33 项，被驱动骨骼下标 */,
             frames: number[] /* frameCount × boneIndices.length × 7，每项 [qx,qy,qz,qw, px,py,pz] */ },
    glide: { fps: 30, frameCount: 90, boneIndices: number[] /* 32 项 */, frames: number[] },
  }
  ```
  ⚠️ `frames` 存的是**相对 bind pose 的增量**（spec §2.2 实测：关键帧是增量语义）。
  ⚠️ 只存被驱动的骨骼（fly 33 / glide 32），其余 45 根运行时自动跟随父级。

- [ ] **Step 1: 写失败测试 `src/tests/test-dragon-bake.js`**

```js
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual } from './assert.js';

// 产物在浏览器里 fetch（同构层不 import node 模块）
let asset = null;
async function loadAsset() {
  if (asset) return asset;
  const r = await fetch(new URL('../../assets/dragon/dragon.json', import.meta.url));
  asset = await r.json();
  return asset;
}

test('龙烘焙: 动画清单与帧数', async () => {
  const d = await loadAsset();
  assertDeepEqual(Object.keys(d.animations).sort(), ['fly', 'glide']);
  assertEqual(d.animations.fly.frameCount, 36);     // 1.2s × 30fps
  assertEqual(d.animations.glide.frameCount, 90);   // 3.0s × 30fps
  assertEqual(d.animations.fly.fps, 30);
});

test('龙烘焙: 只驱动部分骨骼，且下标合法', async () => {
  const d = await loadAsset();
  assertEqual(d.animations.fly.boneIndices.length, 33);
  assertEqual(d.animations.glide.boneIndices.length, 32);
  for (const a of Object.values(d.animations)) {
    assertTrue(a.boneIndices.every(i => i >= 0 && i < d.bones.length));
    assertEqual(a.frames.length, a.frameCount * a.boneIndices.length * 7);
    // 四元数必须归一化（插值前提）
    for (let f = 0; f < a.frameCount; f++)
      for (let b = 0; b < a.boneIndices.length; b++) {
        const o = (f * a.boneIndices.length + b) * 7;
        const n = Math.hypot(a.frames[o], a.frames[o+1], a.frames[o+2], a.frames[o+3]);
        assertTrue(Math.abs(n - 1) < 1e-4, `四元数未归一化 n=${n}`);
      }
  }
});

test('龙烘焙: loop 动画首末帧闭合（catmullrom 采样正确的判据）', async () => {
  const d = await loadAsset();
  for (const [name, a] of Object.entries(d.animations)) {
    const stride = a.boneIndices.length * 7;
    const first = a.frames.slice(0, stride);
    // 末帧之后回到首帧：采样 t=length 应等于 t=0（loop 语义）
    // 故 frames 里**不含** t=length 那一帧（frameCount = length × fps，不是 +1）
    let maxDiff = 0;
    for (let i = 0; i < stride; i++) maxDiff = Math.max(maxDiff, Math.abs(first[i] - a.frames[(a.frameCount-1)*stride + i]));
    // 相邻帧差应远小于「首帧 vs 末帧」的量级？不 —— 判据是：末帧与首帧的差 ≈ 一个帧间隔的差
    assertTrue(maxDiff < 0.5, `${name} 首末帧落差 ${maxDiff} 过大（loop 不闭合或采样错位）`);
  }
});

test('龙烘焙: 采样值落在关键帧值域内（catmullrom 不发散）', async () => {
  const d = await loadAsset();
  // body 骨骼的 position.y 增量：素材关键帧实测在 ±2px（spec §2.2）→ 3 倍后 ±0.375 格
  const bodyIdx = d.bones.findIndex(b => b.name === 'body');
  const a = d.animations.fly;
  const slot = a.boneIndices.indexOf(bodyIdx);
  assertTrue(slot >= 0, 'fly 必须驱动 body');
  let maxY = 0;
  for (let f = 0; f < a.frameCount; f++) maxY = Math.max(maxY, Math.abs(a.frames[(f*a.boneIndices.length+slot)*7 + 5]));
  assertTrue(maxY > 0.05 && maxY < 0.6, `body y 增量 ${maxY} 超出预期值域（采样错或单位错）`);
});
```

在 `src/tests/index.html` 的 import 列表里注册 `import './test-dragon-bake.js';`。

- [ ] **Step 2: 跑测试验证 RED**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: FAIL —— `animations` 是空对象，`Object.keys` 得 `[]`。

- [ ] **Step 3: 实现 catmullrom 重采样**

在 `tools/bake-dragon.mjs` 加：

1. **解析关键帧**：`animations[name].animators` 是 `{uuid: {name, type, keyframes}}`。按骨骼名归组，每骨骼分 `rotation`（欧拉度，可能有 1~2 个 `data_points` 做插值端点）与 `position`（px 增量）两个 channel。
2. **catmullrom 采样**：Blockbench 的 catmullrom 是标准 Catmull-Rom 样条（4 点：p0=前一帧、p1/p2=当前段两端、p3=后一帧）。**loop 动画的邻居要环绕取**（t=0 的 p0 = 最后一帧）。欧拉角**逐分量**插值（与 Blockbench 一致），插值后转四元数增量。
3. **重采样到 30fps**：`frameCount = round(length × fps)`（fly 1.2×30=36、glide 3.0×30=90），第 `f` 帧的时间 = `f / fps`（**不含 t=length**，loop 语义）。
4. **写扁平数组**：每帧每骨骼 7 个数 `[qx,qy,qz,qw, px,py,pz]`；position 的 px → 格（`× scale ÷ pxPerBlock`）。
5. **只收被驱动的骨骼**：`boneIndices` = 该动画 `animators` 里出现的骨骼名 → 下标，排序稳定（按骨骼表序）。

⚠️ 未被该动画驱动的骨骼**不进 frames**（运行时保持 bind pose）。

- [ ] **Step 4: 重烘 + 跑测试验证 GREEN**

```bash
npm run dragon
npx playwright test tests/harness.spec.mjs --reporter=line
```
Expected: PASS（4 条新用例全绿，既有用例零回归）。

⚠️ **harness 的整页等待窗口是 120s，实测已用 63.6s**（AGENTS.md）。本任务新增 4 条用例只做 fetch + 数组遍历，耗时可忽略；但若后续往这个文件加大块逐格用例，须重测整页时长。

- [ ] **Step 5: 提交**

```bash
git add tools/bake-dragon.mjs tools/dragon-fingerprint.mjs assets/dragon src/tests/test-dragon-bake.js src/tests/index.html
git commit -m "feat(dragon): 烘焙期重采样 fly/glide 动画为 30fps 帧序列"
```

---

### Task 3: `check:data` 的 `[龙]` 门禁环节

**Tier:** 2（数据契约）

**Files:**
- Modify: `tools/check-data.mjs`（加 `checkDragonAsset()` + 并入成功行打印条件）

**Interfaces:**
- Consumes: `tools/dragon-fingerprint.mjs` 的全部导出（**import 它，不重写参数** —— 红线 1）
- Produces: `npm run check:data` 输出里的 `[龙]` 环节

- [ ] **Step 1: 写 `checkDragonAsset()`**

照 `checkZombieSkinTexture()`（`check-data.mjs:471`）的结构，判四件事：

1. **产物存在**：`dragon.json` / `dragon.png` / `dragon.meta.json` 缺任一 → `failures.push('[龙] assets/dragon/xxx 不存在 —— 跑 npm run dragon')`。
2. **PNG 尺寸** = `DRAGON_BAKE_PARAMS.textureSize`（128）—— 用 `pngjs` 读（仓库已有该依赖）。
3. **产物契约**（关系式，不硬编码计数）：
   - `manifest.scale === DRAGON_METRICS.scale` 且 `=== 3`
   - `manifest.bones.length === DRAGON_METRICS.boneCount`
   - `manifest.geometry.position.length === DRAGON_METRICS.vertexCount * 3`
   - `manifest.geometry.index.length === DRAGON_METRICS.indexCount`
   - `Object.keys(manifest.animations).sort()` 深等于 `DRAGON_BAKE_PARAMS.animations`
   - 每个动画 `frameCount === round(素材 length × animFps)`（fly 36 / glide 90，从 `DRAGON_METRICS` 读）
4. **指纹**：`meta.fingerprints.input !== dragonInputFingerprint()` → `'[龙] 输入已变但产物未重烘（跑 npm run dragon）'`。

⚠️ **成功行必须涵盖全部判据**（AGENTS.md 已记该坑：新判据只加进 `failures` 而不并进成功行的条件，会同时打印「✗ 含砖块族」与「✓ 无砖无木」，读者只看 ✓ 就误判通过）。写法：

```js
if (!failures.some(f => f.startsWith('[龙]'))) infos.push(`[龙] 产物契约与指纹一致（${...} 骨骼 / ${...} 顶点 / fly+glide）`);
```

- [ ] **Step 2: 负向验证（本任务的 RED）**

临时改 `tools/dragon-fingerprint.mjs` 的 `DRAGON_METRICS.boneCount` 为 77：

Run: `npm run check:data`
Expected: FAIL，报 `[龙] 骨骼数 78 ≠ 期望 77`。

改回 78，再临时把 `assets/dragon/dragon.meta.json` 的 `fingerprints.input` 改一个字符：

Run: `npm run check:data`
Expected: FAIL，报「输入已变但产物未重烘」。

⚠️ **撤销注入必须用 `cp` 副本还原，禁止 `git checkout`/`restore`**（AGENTS.md 已记一次真实数据丢失）。动手前先 `cp tools/dragon-fingerprint.mjs /tmp/dfp.bak`。

- [ ] **Step 3: 跑最小门验证 GREEN + 提交**

```bash
npm run check
git add tools/check-data.mjs
git commit -m "test(dragon): check:data 增加 [龙] 产物契约与指纹门禁"
```

---

### Task 4: `dragon-config.js` + 轨道纯函数 + `dragonDefinition`

**Tier:** 1（纯函数/机制）—— 必须 TDD。

**Files:**
- Create: `src/entities/dragons/dragon-config.js`（冻结玩法数值**唯一权威**，同构无 three）
- Create: `src/entities/dragons/dragon-system.js`（`dragonPoseAt` / `dragonAnimStateAt` / `dragonDefinition`；`DragonService` 在 Task 5）
- Test: `src/tests/test-dragon-system.js`（+ 在 `src/tests/index.html` 注册）

**Interfaces:**
- Consumes:
  - `src/entities/entity-types.js` 的 `raycastAabbSlab(state, origin, dir, maxDist, aabb)`、`normalizePosition(position)`
  - `src/gen/structures/tarn-zone.js` 的 `TARN_PLATEAU_Y`（= `SEA_Y + 4` = 2）
  - `src/voxel/constants.js` 的 `columnKeyAt`（经 `entity-types.js` 的 `columnKeyOfPosition`）
- Produces:
  - `dragon-config.js`：
    ```js
    export const DRAGON_TYPE = 'dragon';
    export const DRAGON = Object.freeze({
      scale: 3, health: 300,
      orbitRadius: 24, orbitYOffset: 28,      // y = TARN_PLATEAU_Y + orbitYOffset = 30
      orbitSpeed: 6,                          // 格/秒
      bobAmplitude: 1.5, bobPeriod: 7,
      bankRoll: 12 * Math.PI / 180,
      flashMs: 200,
    });
    export const DRAGON_ORBIT_SALT = 1040;
    // 身体核心 OBB（模型空间，已含 scale，格）—— spec §5.1 实测值
    export const DRAGON_CORE_OBB = Object.freeze({
      halfExtents: Object.freeze([1.125, 1.875, 4.78125]),
      center: Object.freeze([0, 4.125, -2.53125]),
    });
    // 动画状态机（spec §6.3）：周期 12s = fly 4.0 + 淡入 0.4 + glide 7.2 + 淡出 0.4
    export const DRAGON_ANIM = Object.freeze({
      cycleSeconds: 12, flySeconds: 4.0, glideSeconds: 7.2, blendSeconds: 0.4,
    });
    ```
  - `dragon-system.js`：
    ```js
    /** 轨道 pose 纯函数。@returns {{position:[number,number,number], yaw:number}} */
    export function dragonPoseAt(orbit, t);
    /** 动画状态纯函数。@returns {{primary:'fly'|'glide', secondary:'fly'|'glide'|null, blend:number, primaryTime:number, secondaryTime:number}} */
    export function dragonAnimStateAt(t);
    /** 身体核心 OBB 绕 yaw 旋转后的轴对齐包围盒。@returns {{min:number[],max:number[]}} */
    export function dragonAabbFor(state);
    export const dragonDefinition;   // {create, update, raycastAabb, serialize, deserialize}
    ```
    `orbit` 形状：`{cx, cz, y, radius, omega, phase}`（由 Task 5 的 `DragonService` 在 spawn 时派生并写进 state）。

- [ ] **Step 1: 写失败测试 `src/tests/test-dragon-system.js`**

```js
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual, assertNull } from './assert.js';
import { DRAGON, DRAGON_TYPE, DRAGON_ORBIT_SALT, DRAGON_CORE_OBB, DRAGON_ANIM }
  from '../entities/dragons/dragon-config.js';
import { dragonPoseAt, dragonAnimStateAt, dragonAabbFor, dragonDefinition }
  from '../entities/dragons/dragon-system.js';
import { TARN_PLATEAU_Y } from '../gen/structures/tarn-zone.js';

const ORBIT = Object.freeze({ cx: 100, cz: -50, y: TARN_PLATEAU_Y + DRAGON.orbitYOffset,
  radius: DRAGON.orbitRadius, omega: DRAGON.orbitSpeed / DRAGON.orbitRadius, phase: 0.7 });

test('龙轨道: 确定性（同参同果，逐位）', () => {
  assertDeepEqual(dragonPoseAt(ORBIT, 3.5), dragonPoseAt(ORBIT, 3.5));
});

test('龙轨道: 半径与高度有界', () => {
  for (let t = 0; t < 60; t += 0.37) {
    const p = dragonPoseAt(ORBIT, t).position;
    const r = Math.hypot(p[0] - ORBIT.cx, p[2] - ORBIT.cz);
    assertTrue(Math.abs(r - DRAGON.orbitRadius) < 1e-9, `半径 ${r}`);
    assertTrue(Math.abs(p[1] - ORBIT.y) <= DRAGON.bobAmplitude + 1e-9, `y 越界 ${p[1]}`);
  }
});

test('龙轨道: yaw 是切线方向（头朝 −Z 的模型沿轨道前进）', () => {
  // 判据：yaw 对应的「前向」(sin(−yaw), −cos(yaw)) 必须与轨道切线同向（点积 > 0.99）
  for (const t of [0, 1.3, 4.7]) {
    const { yaw } = dragonPoseAt(ORBIT, t);
    const eps = 1e-4;
    const a = dragonPoseAt(ORBIT, t).position, b = dragonPoseAt(ORBIT, t + eps).position;
    const tx = b[0]-a[0], tz = b[2]-a[2], len = Math.hypot(tx, tz);
    const fx = Math.sin(-yaw), fz = -Math.cos(yaw);
    const dot = (fx*tx + fz*tz) / len;
    assertTrue(dot > 0.99, `t=${t} 前向与切线点积 ${dot}（yaw 符号或 π/2 偏移错）`);
  }
});

test('龙轨道: salt 1040 不与既有占用撞车', () => {
  // 既有占用（程序化扫描实测，spec §6.1）：1020~1027、1029~1039
  const taken = new Set([1020,1021,1022,1023,1024,1025,1026,1027,1029,1030,1031,1032,1033,1034,1035,1036,1037,1038,1039]);
  assertTrue(!taken.has(DRAGON_ORBIT_SALT), `salt ${DRAGON_ORBIT_SALT} 已被占用`);
  assertEqual(DRAGON_ORBIT_SALT, 1040);
});

test('龙 AABB: yaw=0 时是「宽 2.25 × 高 3.75 × 长 9.5625」的盒', () => {
  const st = { position: [10, 30, 20], yaw: 0 };
  const box = dragonAabbFor(st);
  const size = [0,1,2].map(a => box.max[a] - box.min[a]);
  // yaw=0 → 模型 −Z 朝世界 −Z → 长轴落在 z
  assertTrue(Math.abs(size[0] - 2*DRAGON_CORE_OBB.halfExtents[0]) < 1e-9, `宽 ${size[0]}`);
  assertTrue(Math.abs(size[1] - 2*DRAGON_CORE_OBB.halfExtents[1]) < 1e-9, `高 ${size[1]}`);
  assertTrue(Math.abs(size[2] - 2*DRAGON_CORE_OBB.halfExtents[2]) < 1e-9, `长 ${size[2]}`);
});

test('龙 AABB: yaw=π/2 时长轴转到 x（旋转盒真的在转）', () => {
  const st = { position: [10, 30, 20], yaw: Math.PI / 2 };
  const size = (() => { const b = dragonAabbFor(st); return [0,1,2].map(a => b.max[a]-b.min[a]); })();
  assertTrue(Math.abs(size[0] - 2*DRAGON_CORE_OBB.halfExtents[2]) < 1e-9, `长轴应在 x，实测 ${size[0]}`);
  assertTrue(Math.abs(size[2] - 2*DRAGON_CORE_OBB.halfExtents[0]) < 1e-9, `宽轴应在 z，实测 ${size[2]}`);
});

test('龙 AABB: 命中判据在临界距离附近区分（远离阈值的输入测不出旋转错误）', () => {
  const st = { position: [0, 30, 0], yaw: 0 };
  const origin = [0, 30, -20], dir = [0, 0, 1];
  // 长轴半长 4.78125 + center z 偏移 −2.53125 → 盒的 −Z 端在 z = −7.3125
  const edge = -(DRAGON_CORE_OBB.halfExtents[2] + DRAGON_CORE_OBB.center[2]);
  const hitIn  = dragonDefinition.raycastAabb(st, origin, dir, 20 - edge + 0.01);
  const hitOut = dragonDefinition.raycastAabb(st, origin, dir, 20 - edge - 0.01);
  assertTrue(hitIn !== null, '临界内侧应命中');
  assertNull(hitOut, '临界外侧应脱靶');
});

test('龙动画状态机: fly/glide 交替且周期闭合', () => {
  const A = DRAGON_ANIM;
  assertEqual(dragonAnimStateAt(0).primary, 'fly');
  assertEqual(dragonAnimStateAt(0).blend, 0);
  // fly 段末尾进入淡入
  const s1 = dragonAnimStateAt(A.flySeconds + A.blendSeconds / 2);
  assertTrue(s1.blend > 0 && s1.blend < 1, `淡入期 blend=${s1.blend}`);
  // glide 段中期：纯 glide
  const s2 = dragonAnimStateAt(A.flySeconds + A.blendSeconds + A.glideSeconds / 2);
  assertEqual(s2.primary, 'glide'); assertEqual(s2.blend, 0); assertNull(s2.secondary);
  // 周期末回到起点（12s ≡ 0s）
  assertDeepEqual(dragonAnimStateAt(A.cycleSeconds), dragonAnimStateAt(0));
});

test('龙 definition: update 返回全新 state（M5 不变式，不可原地改写）', () => {
  const st = dragonDefinition.create({ position: [0, 30, 0], yaw: 0, orbit: ORBIT, orbitT: 0,
    health: DRAGON.health, flashedUntil: 0 });
  const before = { pos: [...st.position], t: st.orbitT };
  const next = dragonDefinition.update({ state: st }, 1 / 60, {});
  assertTrue(next !== st, '必须返回新对象');
  assertTrue(next.position !== st.position, 'position 数组也必须是新的');
  assertEqual(st.orbitT, before.t, '原 state 不得被改写');
  assertTrue(next.orbitT > before.t);
});

test('龙 definition: create 拒绝非法 position', () => {
  assertNull(dragonDefinition.create({ position: [NaN, 0, 0], orbit: ORBIT }));
  assertNull(dragonDefinition.create({ position: [0, 0], orbit: ORBIT }));
});
```

在 `src/tests/index.html` 注册。

- [ ] **Step 2: 跑测试验证 RED**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: FAIL —— 模块不存在（`Cannot find module` 或整页不加载）。

- [ ] **Step 3: 写 `dragon-config.js`**

按上面 Interfaces 的确切值。文件头注释写明：本文件是龙玩法数值的**唯一权威**（同构层，无 DOM 无 three，`check:arch` 守）；`orbitYOffset` 的用户裁定出处（spec §1 第 5 行「约 28 格高」）与 `orbitRadius: 24` 的净空推导（spec §6.2：翼尖最远 32.25 < 高台最近格 34.5）。

⚠️ `flashMs: 200` 与 `ZOMBIE_FLASH_MS` 数值相同但**各自持有常量、不互相 import**（entities/dragons 不依赖 entities/zombies）。

- [ ] **Step 4: 写 `dragon-system.js` 的三个纯函数 + definition**

- `dragonPoseAt(orbit, t)`：spec §6.1 公式。`θ = phase + omega × t`；`y = orbit.y + bobAmplitude × sin(2π t / bobPeriod)`；`yaw = θ + π/2`（**符号由 Step 1 的切线用例钉住** —— 若 FAIL 就试 `θ − π/2`，不要改测试）。
- `dragonAnimStateAt(t)`：`tc = t mod cycleSeconds`，按 `[0, fly) → fly 纯`、`[fly, fly+blend) → 淡入（primary=fly, secondary=glide, blend 0→1）`、`[fly+blend, fly+blend+glide) → glide 纯`、`[末 blend) → 淡出（primary=glide, secondary=fly, blend 0→1）` 四段返回。
- `dragonAabbFor(state)`：把 `DRAGON_CORE_OBB` 的 8 个角先加 `center`、绕 y 轴转 `state.yaw`、再加 `state.position`，取 min/max。**不缓存**（每帧一次，8 点 × 3 轴可忽略）。
- `dragonDefinition`：
  - `create(state)`：`normalizePosition` 校验 + `orbit` 六字段有限 + `orbitT`/`health`/`flashedUntil` 归一化（缺省 `DRAGON.health` / 0）。
  - `update(entity, dt)`：`orbitT += dt` → `dragonPoseAt` → 返回**全新 state + 全新 position 数组**（M5 不变式：原地改写会让 `_migrateColumn` 的 before/after 从同一份算出 → 索引永不迁移）。
  - `raycastAabb(state, origin, dir, maxDist)`：`raycastAabbSlab(state, origin, dir, maxDist, dragonAabbFor(state))`。
  - `serialize/deserialize`：`{position, yaw, orbitT, health}`（临时实体不走存档，最小实现）。

⚠️ **不 import three、不 import DOM**（同构层）。`update` 不读 context（轨道参数全在 state 里，龙不与方块交互）。

- [ ] **Step 5: 跑测试验证 GREEN**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS（10 条新用例全绿）。

- [ ] **Step 6: 负向验证**

逐个注入并确认**真 FAIL**（撤销用 `cp` 副本，禁止 `git checkout`）：

| 注入 | 预期红的用例 |
|---|---|
| `yaw = θ − π/2`（符号反） | 「yaw 是切线方向」 |
| `dragonAabbFor` 忽略 `state.yaw`（恒 yaw=0） | 「yaw=π/2 时长轴转到 x」 |
| `update` 原地改写 `entity.state.orbitT` 后返回同一对象 | 「update 返回全新 state」 |
| `DRAGON_ORBIT_SALT = 1024`（撞 tarn 云） | 「salt 1040 不撞车」 |

- [ ] **Step 7: 提交**

```bash
git add src/entities/dragons src/tests/test-dragon-system.js src/tests/index.html
git commit -m "feat(dragon): 龙玩法数值与轨道/动画/AABB 纯函数 + definition"
```

---

### Task 5: `DragonService`（spawn 编排 / damage / 死亡标记）

**Tier:** 1（机制）—— 必须 TDD。

**Files:**
- Modify: `src/entities/dragons/dragon-system.js`（加 `DragonService` 类）
- Modify: `src/save/persistence.js`（加 `saveDragonDead(dead)`，merge 写 meta）
- Test: `src/tests/test-dragon-system.js`（追加用例）

**Interfaces:**
- Consumes:
  - Task 4 的 `dragonDefinition` / `dragonPoseAt` / `DRAGON_TYPE` / `DRAGON` / `DRAGON_ORBIT_SALT`
  - `src/entities/entity-manager.js` 的 `EntityManager`（`spawn` / `get` / `despawn` / `entities`）
  - `src/gen/structures/tarn-zone.js` 的 `findAltarTarnRegion(seed)` → `{regionX, regionZ, cx, cz, dist} | null`
  - `src/gen/noise.js` 的 `seededRandom(x, z, salt)`（phase 派生）
  - `src/save/persistence.js` 的 `Persistence`（`loadMeta` / `_metaCache`）
- Produces:
  ```js
  export class DragonService {
    /** @param {{entities: EntityManager, persistence: Persistence|null, seed: number,
    *            world: {hasColumn(cx:number,cz:number):boolean}}} deps */
    constructor(deps);
    /** 每帧由 game 调（entities.update 之前）。未死 && 无实体 && 祭坛地带中心 column 已就绪 → spawn */
    ensure();
    /** 与 ZombieService.damage 同形状。@returns {{dead:boolean, health:number}|null} */
    damage(id, amount, nowMs);
    /** 当前龙实体或 null（渲染器与炮塔目标集合消费） */
    active();
    /** @returns {boolean} meta.dragonDead */
    isDead();
    /** 启动时从 meta 恢复死亡标记（game.start 调一次） */
    hydrate(metaRow);
    dispose();
  }
  ```
  `Persistence.saveDragonDead(dead)`：merge 进 `_metaCache` 再整行 put（**与 `savePlayerPos` 完全同一手法** —— `saveMeta` 是整行覆盖，直接写会抹掉 `seed`/`spawn`/`playerPos`）。

- [ ] **Step 1: 写失败测试（追加到 `test-dragon-system.js`）**

```js
// ⚠️ Task 4 已在文件顶部 import 了 TARN_PLATEAU_Y；本任务只需把 findAltarTarnRegion
// 加进同一行（不要重复 import 同一模块）：
//   import { findAltarTarnRegion, TARN_PLATEAU_Y } from '../gen/structures/tarn-zone.js';
import { EntityManager } from '../entities/entity-manager.js';
import { DragonService } from '../entities/dragons/dragon-system.js';
import { columnKeyAt } from '../voxel/constants.js';   // ⚠️ column 键的唯一权威，不自己拼 `${cx},${cz}`
import { findAltarTarnRegion, TARN_PLATEAU_Y } from '../gen/structures/tarn-zone.js';

/** 祭坛地带中心所在的 column key（多处用例共用） */
function altarColumnKey(seed) {
  const a = findAltarTarnRegion(seed);
  return a ? columnKeyAt(a.cx, a.cz) : null;
}
/** 找一个真有/没有祭坛地带的 seed（复用 gen 层权威，不自己写判据） */
function findSeedWithAltar(want) {
  for (let s = 1; s < 200; s++) if ((findAltarTarnRegion(s) !== null) === want) return s;
  return null;
}

/** fake persistence：必须建模真实对象的副作用（AGENTS.md：形状对了副作用没建模照样是盲区） */
function fakePersistence(initialMeta = {}) {
  const store = { meta: { ...initialMeta } };
  return {
    store,
    saveMeta(obj) { store.meta = { ...obj, key: 'main' }; return Promise.resolve(); },
    // 真实 saveDragonDead 是 merge 写：这里照抄语义，才能拓到「整行覆盖抹掉 seed」的缺陷
    saveDragonDead(dead) { store.meta = { ...store.meta, dragonDead: dead, key: 'main' }; return Promise.resolve(); },
  };
}
function fakeWorld(readyKeys = new Set()) {
  return { hasColumn: (cx, cz) => readyKeys.has(`${cx},${cz}`) };
}
test('龙 service: 无祭坛地带时永不 spawn', () => {
  const em = new EntityManager();
  em.registerType(DRAGON_TYPE, dragonDefinition);
  // 构造一个 findAltarTarnRegion 返回 null 的 seed：扫描若干 seed 找到它
  const seed = findSeedWithAltar(false);
  assertTrue(seed !== null, '测试前提：应存在无祭坛地带的 seed');
  // ⚠️ column 门控必须**恒真**，否则这条用例拓不到「地带缺失」而只拓到「column 未就绪」
  const svc = new DragonService({ entities: em, persistence: fakePersistence(), seed,
    world: { hasColumn: () => true } });
  for (let i = 0; i < 5; i++) svc.ensure();
  assertEqual(svc.active(), null);
  assertEqual(em.count(DRAGON_TYPE), 0);
});

test('龙 service: 祭坛地带 column 就绪后 spawn 一条，位置在轨道上', () => {
  const em = new EntityManager(); em.registerType(DRAGON_TYPE, dragonDefinition);
  const seed = findSeedWithAltar(true);
  const altar = findAltarTarnRegion(seed);
  const svc = new DragonService({ entities: em, persistence: fakePersistence(), seed,
    world: fakeWorld(new Set([altarColumnKey(seed)])) });
  svc.ensure();
  const e = svc.active();
  assertTrue(e !== null, '应 spawn 一条龙');
  assertEqual(em.count(DRAGON_TYPE), 1);
  // 位置在轨道上：水平距祭坛中心 = orbitRadius（±bob 只影响 y）
  const r = Math.hypot(e.state.position[0] - altar.cx, e.state.position[2] - altar.cz);
  assertTrue(Math.abs(r - DRAGON.orbitRadius) < 1e-6, `轨道半径 ${r}`);
  assertEqual(e.state.position[1] >= TARN_PLATEAU_Y + DRAGON.orbitYOffset - DRAGON.bobAmplitude, true);
  // 幂等：再 ensure 不会多 spawn
  svc.ensure(); svc.ensure();
  assertEqual(em.count(DRAGON_TYPE), 1);
});

test('龙 service: column 未就绪时不 spawn（就绪后才 spawn）', () => {
  const em = new EntityManager(); em.registerType(DRAGON_TYPE, dragonDefinition);
  const seed = findSeedWithAltar(true);
  const w = fakeWorld(new Set());
  const svc = new DragonService({ entities: em, persistence: fakePersistence(), seed, world: w });
  svc.ensure();
  assertEqual(svc.active(), null, '未就绪不得 spawn');
  w.hasColumn = () => true;
  svc.ensure();
  assertTrue(svc.active() !== null, '就绪后应 spawn');
});

test('龙 service: 被 column 卸载回收后自动重生（位置由纯函数重算）', () => {
  const em = new EntityManager(); em.registerType(DRAGON_TYPE, dragonDefinition);
  const seed = findSeedWithAltar(true);
  const svc = new DragonService({ entities: em, persistence: fakePersistence(), seed,
    world: fakeWorld(new Set([altarColumnKey(seed)])) });
  svc.ensure();
  const first = svc.active().state.position.slice();
  // 模拟玩家走远 → column 卸载回收临时实体
  em.despawnColumn(columnKeyAt(first[0], first[2]), 'column-unloaded');
  assertEqual(svc.active(), null, '回收后应无实体');
  assertEqual(svc.isDead(), false, '回收不等于死亡');
  svc.ensure();
  const second = svc.active();
  assertTrue(second !== null, '应重生（Review Focus 第 4 条）');
  // 位置仍在轨道上（纯函数重算，不依赖旧 state）
  const altar = findAltarTarnRegion(seed);
  const r = Math.hypot(second.state.position[0] - altar.cx, second.state.position[2] - altar.cz);
  assertTrue(Math.abs(r - DRAGON.orbitRadius) < 1e-6, `重生后轨道半径 ${r}`);
});

test('龙 service: damage 精确扣血 + 红闪时间戳（performance.now 口径）', () => {
  const em = new EntityManager(); em.registerType(DRAGON_TYPE, dragonDefinition);
  const seed = findSeedWithAltar(true);
  const svc = new DragonService({ entities: em, persistence: fakePersistence(), seed,
    world: fakeWorld(new Set([altarColumnKey(seed)])) });
  svc.ensure();
  const id = svc.active().id;
  const now = 12345.6;   // performance.now() 量级（不是 Date.now() 的 1.7e12）
  const r = svc.damage(id, 100, now);
  assertEqual(r.dead, false);
  assertEqual(r.health, DRAGON.health - 100);
  assertEqual(svc.active().state.flashedUntil, now + DRAGON.flashMs);
  // 临界序列：300 血 → 三发 100 死（在临界值附近断言，远离阈值测不出换算错）
  svc.damage(id, 100, now + 1);
  assertEqual(svc.active().state.health, 100);
  const dead = svc.damage(id, 100, now + 2);
  assertEqual(dead.dead, true);
  assertEqual(svc.active(), null, '死亡后实体应消失');
  assertEqual(svc.isDead(), true);
});

test('龙 service: 死亡后 ensure 不再 spawn（永久死亡）', () => {
  const em = new EntityManager(); em.registerType(DRAGON_TYPE, dragonDefinition);
  const seed = findSeedWithAltar(true);
  const p = fakePersistence({ dragonDead: true, seed: 999, spawn: [1,2,3] });
  const svc = new DragonService({ entities: em, persistence: p, seed,
    world: fakeWorld(new Set([altarColumnKey(seed)])) });
  svc.hydrate(p.store.meta);
  for (let i = 0; i < 3; i++) svc.ensure();
  assertEqual(svc.active(), null);
  assertEqual(em.count(DRAGON_TYPE), 0);
});

test('龙 service: 死亡标记是 merge 写，不抹掉 meta 其它字段', async () => {
  const em = new EntityManager(); em.registerType(DRAGON_TYPE, dragonDefinition);
  const seed = findSeedWithAltar(true);
  const p = fakePersistence({ seed: 999, spawn: [1, 2, 3], playerPos: { x: 5, y: 6, z: 7 } });
  const svc = new DragonService({ entities: em, persistence: p, seed,
    world: fakeWorld(new Set([altarColumnKey(seed)])) });
  svc.hydrate(p.store.meta);
  svc.ensure();
  const id = svc.active().id;
  svc.damage(id, 9999, 1000);
  await Promise.resolve();
  assertEqual(p.store.meta.seed, 999, 'seed 被抹掉了（整行覆盖而非 merge）');
  assertDeepEqual(p.store.meta.spawn, [1, 2, 3]);
  assertDeepEqual(p.store.meta.playerPos, { x: 5, y: 6, z: 7 });
  assertEqual(p.store.meta.dragonDead, true);
});

test('龙 service: damage 未知 id 返回 null', () => {
  const em = new EntityManager(); em.registerType(DRAGON_TYPE, dragonDefinition);
  const svc = new DragonService({ entities: em, persistence: fakePersistence(), seed: 1, world: fakeWorld() });
  assertNull(svc.damage('nope', 10, 0));
});
```

- [ ] **Step 2: 跑测试验证 RED**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: FAIL —— `DragonService` 未导出。

- [ ] **Step 3: 实现 `Persistence.saveDragonDead(dead)`**

照 `savePlayerPos`（`persistence.js:118-131`）的 merge 手法：

```js
saveDragonDead(dead) {
  const merged = { ...(this._metaCache || {}), dragonDead: !!dead, key: 'main' };
  this._metaCache = merged;
  return this._put('meta', merged);
}
```

⚠️ 文件头注释补一句：`dragonDead` 与 `playerPos` 同为「增量 merge 写字段」，`saveMeta` 的整行 put 语义会让它们互相抹掉 —— 两个字段都必须走 merge 路径。

- [ ] **Step 4: 实现 `DragonService`**

- `constructor`：存 deps；`this._dead = false`；`this._orbit = null`（惰性派生，memo 到 seed）。
  ⚠️ **memo 变量名里不得出现 `RegionCache` 子串**（`check:arch` 的 `FORBIDDEN_NAMES` 是子串匹配，AGENTS.md 已记该坑：v2.30 的 `_altarRegionCache` 被静态门当场拦下）。用 `_orbitMemo` 这类词根。
- `_orbitFor()`：`findAltarTarnRegion(seed)` → null 则返回 null；否则
  `{cx, cz, y: TARN_PLATEAU_Y + DRAGON.orbitYOffset, radius: DRAGON.orbitRadius,
    omega: DRAGON.orbitSpeed / DRAGON.orbitRadius,
    phase: seededRandom(0, 0, seed + DRAGON_ORBIT_SALT) * Math.PI * 2}`。
  ⚠️ **转调 `findAltarTarnRegion`，不自己写「哪个地带带祭坛」**（红线 1：两份判据漂移 = 「按钮到的地带没龙」）。它自带 seed 级 memo。
- `ensure()`：`if (this._dead) return;` → `if (this.active()) return;` → `orbit = this._orbitFor()`，null 则 return → **column 就绪门控**：`world.hasColumn(floor(cx/16), floor(cz/16))` 为假则 return（避免在未加载区 spawn 出一个玩家看不见的实体，也让「传送过去才出现」自然成立）→ `entities.spawn({id, type: DRAGON_TYPE, state: dragonDefinition.create({position: dragonPoseAt(orbit, 0).position, yaw: ..., orbit, orbitT: 0, health: DRAGON.health, flashedUntil: 0}), persistent: false})`。
  ⚠️ **`persistent: false` 是刻意选择**（spec 分叉二方案 A）：位置是 seed 的纯函数，进存档就是第二份权威（红线 2）。代价 = column 卸载会被回收 → 靠 `ensure()` 重生（血量重置，spec §5.2 已记取舍）。
  ⚠️ id 用 `dragon-altar`（全世界唯一一条，固定 id 让重生幂等；`EntityManager.spawn` 撞 id 返回 null，`ensure` 的 `active()` 前置检查已避免）。
- `damage(id, amount, nowMs)`：`entities.get(id)` → 类型不是 `DRAGON_TYPE` 或不存在 → `null`。否则照 `ZombieService.damage`（`zombie-system.js:428-441`）：算 `health`、`flashedUntil = nowMs + DRAGON.flashMs`、**经 `dragonDefinition.create` 重建 state**（不原地改）、`health <= 0` → `entities.despawn(id, 'killed')` + `this._dead = true` + `persistence?.saveDragonDead(true)`（不 await，失败只 `console.warn`）→ 返回 `{dead, health}`。
- `active()`：`entities.get('dragon-altar')`（或遍历 `entities()` 找 type，取前者更省）。
- `isDead()` / `hydrate(metaRow)`：`this._dead = !!(metaRow && metaRow.dragonDead)`。
- `dispose()`：despawn 活着的龙。

⚠️ **不 import three、不 import DOM**（同构层）。`world` 只用 `hasColumn`（依赖注入，不 import WorldData 类）。

- [ ] **Step 5: 跑测试验证 GREEN**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS（8 条新用例全绿，Task 4 的 10 条零回归）。

- [ ] **Step 6: 负向验证**

| 注入 | 预期红的用例 |
|---|---|
| `saveDragonDead` 写成整行 put（`{dragonDead, key}` 不 merge） | 「死亡标记是 merge 写」 |
| `ensure()` 去掉 `if (this._dead) return` | 「死亡后 ensure 不再 spawn」 |
| `spawn` 传 `persistent: true` | 无单测能抓（EntityManager 不校验）→ **靠 Task 8 的 E2E 用例 ⑥**（reload 后位置仍是纯函数派生） |
| `damage` 原地改 `entity.state.health` | 「damage 精确扣血」（`flashedUntil` 断言会读到未重建的 state） |
| `_orbitFor` 自己写「最近地带」判据而不调 `findAltarTarnRegion` | 无单测能抓 → 靠 code review；**在文件头注释里写明红线 1 理由** |

- [ ] **Step 7: 提交**

```bash
git add src/entities/dragons/dragon-system.js src/save/persistence.js src/tests/test-dragon-system.js
git commit -m "feat(dragon): DragonService（spawn 编排 / damage / meta 死亡标记）"
```

---

### Task 6: 伤害路由泛化（分叉一方案 A）

**Tier:** 1（机制 + 跨模块接口）—— 必须 TDD，且**丧尸零回归是硬门**。

**Files:**
- Modify: `src/entities/entity-types.js`（加 `WEAPON_HITTABLE_TYPES`）
- Modify: `src/player/weapons/weapon-controller.js:184`（predicate 改注入）
- Modify: `src/entities/turrets/projectile-system.js:121`（predicate 改集合）
- Modify: `src/entities/turrets/turret-system.js:102`（参数 `zombies` → `targets`，每项可带 `bodyOffsetY`）
- Modify: `src/core/game.js:854`（`damage` → `damageEntity`）、`:2302-2307`（targets 并入龙）、`:2358`（`onDamage` → `damageEntity`）
- Test: `src/tests/test-turrets.js`（改名 + 追加龙目标用例）、`src/tests/test-weapons.js`（追加 `isHittable` 用例）

**Interfaces:**
- Consumes: Task 4 的 `DRAGON_TYPE`；Task 5 的 `DragonService.damage`
- Produces:
  - `entity-types.js`：`export const WEAPON_HITTABLE_TYPES = Object.freeze(['zombie', 'dragon']);`
  - `weapon-controller.js`：`entityQuery` 契约新增可选字段 `isHittable?: (entity) => boolean`（缺省回落 `(e) => e.type === 'zombie'`，保 M4 既有测试逐位不变）
  - `turret-system.js`：`computeTurretUpdates({turrets, targets, world, registry})`，`targets` 每项 `{id, position, bodyOffsetY?}`（缺省 `TURRET.enemyBodyOffsetY`）
  - `game.js`：`damageEntity(id, amount, nowMs)` → `{dead, health} | null`

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-turrets.js` 追加（**先备份既有丧尸用例的 updates 结果**用于零回归比对）：

```js
test('炮塔索敌: targets 参数改名后丧尸行为逐位零回归', () => {
  // 同一组输入，分别用旧参数名与新参数名调用，updates 必须深相等
  const zombies = [{ id: 'z1', position: [5, 10, 0] }];
  const turrets = [{ id: 't1', pivot: [0, 10, 0], rotation: 0 }];
  const viaTargets = computeTurretUpdates({ turrets, targets: zombies, world, registry });
  // 期望值取自改名前的实测（yaw = atan2(5, 0) = π/2，pitch = atan2(1.2, 5)）
  assertEqual(viaTargets.updates.length, 1);
  assertTrue(Math.abs(viaTargets.updates[0].targetYaw - Math.PI / 2) < 0.01);
  assertEqual(viaTargets.updates[0].hasTarget, true);
  assertEqual(viaTargets.updates[0].targetId, 'z1');
});

test('炮塔索敌: 龙目标用 bodyOffsetY = 0（position 就是身体中心）', () => {
  const targets = [{ id: 'dragon-altar', position: [24, 30, 0], bodyOffsetY: 0 }];
  const turrets = [{ id: 't1', pivot: [0, 6.3, 0], rotation: 0 }];
  const r = computeTurretUpdates({ turrets, targets, world, registry });
  assertEqual(r.updates[0].hasTarget, true);
  // pitch = atan2(30 − 6.3, 24) ≈ 0.78 rad（若误用 +1.2 偏移会得 atan2(24.9,24) ≈ 0.80）
  const expected = Math.atan2(30 - 6.3, 24);
  assertTrue(Math.abs(r.updates[0].targetPitch - expected) < 1e-6,
    `pitch=${r.updates[0].targetPitch} 期望 ${expected}（bodyOffsetY 未生效）`);
});

test('炮塔索敌: 丧尸与龙同时在候选里，取最近', () => {
  const targets = [
    { id: 'dragon-altar', position: [24, 30, 0], bodyOffsetY: 0 },
    { id: 'z1', position: [5, 6.3, 0] },   // 更近
  ];
  const r = computeTurretUpdates({ turrets: [{ id: 't1', pivot: [0, 6.3, 0], rotation: 0 }],
    targets, world, registry });
  assertEqual(r.updates[0].targetId, 'z1');
});
```

在 `src/tests/test-weapons.js`（**已存在**，:40 有 `makeControllerFixture()`）追加：

⚠️ 本文件 :5 只 import 了 `{assertEqual, assertFalse, assertTrue}`，第三条用例用到
`assertDeepEqual` → **需把它加进那行 import**（否则 ReferenceError，整页用例不跑）。
⚠️ `WEAPONS` / `WEAPON_IDS` 已在 :7-9 import；`WEAPON_HITTABLE_TYPES` 需新增一行
`import { WEAPON_HITTABLE_TYPES } from '../entities/entity-types.js';`。

```js
test('武器命中: isHittable 缺省回落只认 zombie（M4 零回归）', () => {
  // ⚠️ 用本文件既有的 makeControllerFixture()（test-weapons.js:40），不要凭空造 helper
  const { controller, aim } = makeControllerFixture();
  let gotPredicate = null;
  controller.setEntityQuery({
    raycast: (o, d, r, predicate) => { gotPredicate = predicate; return null; },
    damage: () => {},
  });
  controller.select('pistol');
  controller.fireOnce(aim);   // 真实路径：fireOnce → _tryFire → _fireHitscan → _queryEntityHit
  assertTrue(gotPredicate !== null, '未发起实体射线（select/fireOnce 没走到 _queryEntityHit）');
  assertTrue(gotPredicate({ type: 'zombie' }), '缺省应放行 zombie');
  assertFalse(gotPredicate({ type: 'dragon' }), '缺省不得放行 dragon（M4 零回归）');
});

test('武器命中: 注入 isHittable 后龙也可被击中', () => {
  const { controller, aim } = makeControllerFixture();
  let gotPredicate = null;
  controller.setEntityQuery({
    raycast: (o, d, r, predicate) => { gotPredicate = predicate; return null; },
    damage: () => {},
    isHittable: (e) => WEAPON_HITTABLE_TYPES.includes(e.type),
  });
  controller.select('pistol');
  controller.fireOnce(aim);
  assertTrue(gotPredicate({ type: 'dragon' }), '注入后应放行 dragon');
  assertTrue(gotPredicate({ type: 'zombie' }));
  assertFalse(gotPredicate({ type: 'minecart' }), '非可击中类型仍拒绝');
});
test('武器命中: 打中龙时 damage 被调且伤害量取自武器目录', () => {
  const { controller, aim } = makeControllerFixture();
  const damaged = [];
  controller.setEntityQuery({
    // 实体 dist 必须**严格小于**方块 dist（fixture 的 aim.target.dist = 2）才算命中
    raycast: (o, d, r, predicate) => {
      const dragon = { id: 'dragon-altar', type: 'dragon' };
      return predicate(dragon) ? { id: dragon.id, dist: 1 } : null;
    },
    damage: (id, amount) => damaged.push([id, amount]),
    isHittable: (e) => WEAPON_HITTABLE_TYPES.includes(e.type),
  });
  controller.select('pistol');
  controller.fireOnce(aim);
  assertDeepEqual(damaged, [['dragon-altar', WEAPONS[WEAPON_IDS.PISTOL].entityDamage]]);
});
```

⚠️ **触发实体射线的真实手法是 `controller.select('pistol')` + `controller.fireOnce(aim)`**
（`test-weapons.js:183-189` 同手法）—— **没有 `tryFireEntityHit` 这个方法**，调用链是
`fireOnce` → `_tryFire` → `_fireHitscan` → `_queryEntityHit`。
⚠️ **`select` 不可省**：`_tryFire` 第一行就是 `if (this.selectedId === WEAPON_IDS.ARM) return []`，
fixture 不自带 select → 不选武器时根本走不到实体射线（用例会在 `gotPredicate !== null` 上红，
那是测试写错，不是实现错）。

- [ ] **Step 2: 跑测试验证 RED**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: FAIL —— `computeTurretUpdates` 还不认 `targets` 参数（`list` 为空 → `hasTarget: false`）。

- [ ] **Step 3: 改 `entity-types.js`**

加 `WEAPON_HITTABLE_TYPES`，注释写明：这是「哪些实体类型可被武器/弹丸击中」的唯一权威（红线 1），三处消费方（`weapon-controller` 经注入、`projectile-system` 直接 import、`turret-system` 的目标集合由 Game 构造）都从它派生。加新实体类型时只改这一处。

- [ ] **Step 4: 改 `turret-system.js`**

`computeTurretUpdates({turrets, zombies, world, registry})` → `({turrets, targets, world, registry})`；`const list = zombies ?? []` → `targets ?? []`；瞄准点 y 改为 `z.position[1] + (z.bodyOffsetY ?? TURRET.enemyBodyOffsetY)`。

⚠️ **JSDoc 的 `@param` 同步改名**（否则文档与实现漂移）。注释里写明：`bodyOffsetY` 缺省是丧尸胸部偏移（mc-lite `ENEMY_BODY_OFFSET_Y`），龙传 0 因为它的 `position` 就是身体中心（spec §11 第 3 条）。

- [ ] **Step 5: 改 `projectile-system.js`**

`(entity) => entity.type === 'zombie'` → `(entity) => WEAPON_HITTABLE_TYPES.includes(entity.type)`（同层 import `../entity-types.js`，已有该 import）。注释同步：「只打可击中类型（丧尸/龙），不打其它弹丸」。

- [ ] **Step 6: 改 `weapon-controller.js`**

```js
const hittable = this.entityQuery.isHittable ?? ((e) => e.type === 'zombie');
const hit = this.entityQuery.raycast(origin, forward, weapon.entityRange, hittable);
```

⚠️ **缺省回落必须保留**（M4 既有测试与交互逐位不变）。`setEntityQuery` 的校验仍是「`raycast` 与 `damage` 必须是函数」（`isHittable` 可选，不加入必需校验）。JSDoc 的 `@param` 类型补 `isHittable?: Function`。
⚠️ **controller 仍不得 import entities/**（它的自声明约束：注入而非 import，依赖方向 §3）。

- [ ] **Step 7: 改 `game.js` 三处**

1. 新增方法（放在 `explodeTnt` 附近的玩法方法区）：
   ```js
   /**
    * 伤害分发器（spec §5.3 分叉一方案 A）：按实体类型路由到对应 service。
    * Game 是装配层，依赖任何层合法（§3）—— 这是「三处硬编码 zombie」的唯一收敛点。
    */
   damageEntity(id, amount, nowMs) {
     const entity = this.entities.get(id);
     if (!entity) return null;
     if (entity.type === 'zombie') return this.zombies.damage(id, amount, nowMs);
     if (entity.type === DRAGON_TYPE) return this.dragons.damage(id, amount, nowMs);
     return null;
   }
   ```
   ⚠️ `this.dragons` 在 Task 8 才创建 → **本任务先加 `if (!this.dragons) return null;` 守卫**，Task 8 接线后守卫自然不再触发（保留它作纵深防御：装配顺序错时不会抛 TypeError）。
2. `setEntityQuery`（`:852-856`）：`damage: (id, amount, nowMs) => this.damageEntity(id, amount, nowMs)`，新增 `isHittable: (entity) => WEAPON_HITTABLE_TYPES.includes(entity.type)`（import 自 `entities/entity-types.js`）。
3. `_updateTurrets`（`:2302-2307`）：
   ```js
   const targets = this.zombies.activeEntities().map((e) => ({ id: e.id, position: [...e.state.position] }));
   const dragon = this.dragons?.active();
   if (dragon) targets.push({ id: dragon.id, position: [...dragon.state.position], bodyOffsetY: 0 });
   const { updates } = computeTurretUpdates({ turrets, targets, world: this.world, registry: this.registry });
   ```
4. `_updateProjectiles`（`:2358`）：`onDamage: (id, amount, ms) => this.damageEntity(id, amount, ms)`。

- [ ] **Step 8: 同步既有测试的参数名**

`src/tests/test-turrets.js` 里所有 `computeTurretUpdates({ ..., zombies, ... })` → `targets`。

⚠️ **只改参数名，断言一字不动** —— 这是零回归的判据。若某条断言因此变红，说明实现改了行为（不是改名），停下来查。

Run: `grep -c "zombies," src/tests/test-turrets.js`（改前）与改后比对，确认全部替换。

- [ ] **Step 9: 跑测试验证 GREEN**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS（新用例全绿 + `test-turrets.js` 既有用例零回归）。

- [ ] **Step 10: 负向验证**

| 注入 | 预期红 |
|---|---|
| `turret-system.js` 的 `bodyOffsetY ?? TURRET.enemyBodyOffsetY` 写成恒 `TURRET.enemyBodyOffsetY` | 「龙目标用 bodyOffsetY = 0」 |
| `projectile-system.js` 的 predicate 改回 `=== 'zombie'` | 无单测（弹丸打龙要 Tier 4）→ **靠 Task 8 的 E2E 用例 ④** |
| `weapon-controller.js` 的缺省回落删掉（`isHittable` 必需） | M4 既有武器用例（`test-weapons.js` / `weapons-logic.spec.mjs`） |
| `game.js` 的 `damageEntity` 仍写 `this.zombies.damage` | **靠 Task 8 的 E2E 用例 ②**（射击龙 health 不动） |

- [ ] **Step 11: 跑炮塔与武器的 Tier 4 回归 + 提交**

```bash
npx playwright test tests/turrets.spec.mjs tests/weapons.spec.mjs tests/zombies.spec.mjs --reporter=line
git add src/entities/entity-types.js src/entities/turrets src/player/weapons src/core/game.js src/tests
git commit -m "refactor(entities): 伤害路由按实体类型分发，炮塔索敌目标集合泛化"
```

Expected: 三个 spec 全绿（丧尸/炮塔/武器零回归）。

---

### Task 7: `dragon-model.js` + `dragon-renderer.js`（SkinnedMesh）+ fixture

**Tier:** 4（GPU 渲染结果）—— 必须像素实测，**不宣称目视**。

**Files:**
- Create: `src/render/dragon-model.js`（产物装载 + 动画采样 helper）
- Create: `src/render/dragon-renderer.js`（SkinnedMesh 构建 + 每帧 pose 发布）
- Create: `src/tests/test-dragon-render.html`（黑背景隔离 fixture，同 `test-zombie-model.html` 手法）
- Create: `tests/dragon-render.spec.mjs`（Tier 4 像素实测）
- Test: `src/tests/test-dragon-render.js`（渲染层纯逻辑：骨骼数/几何属性/visible 门控；在 `index.html` 注册）

**Interfaces:**
- Consumes: Task 1/2 的 `assets/dragon/dragon.json` + `dragon.png`；Task 4 的 `DRAGON` / `DRAGON_ANIM` / `dragonAnimStateAt`；`src/core/resource-url.js` 的 `resourceUrl`
- Produces:
  ```js
  // dragon-model.js
  export async function loadDragonAsset();   // → {bones, geometry, animations, metrics, scale}
  /** 采样某动画某时刻的骨骼增量。@returns {Map<number, {rot:[x,y,z,w], pos:[x,y,z]}>} boneIndex → 增量 */
  export function sampleDragonAnim(anim, timeSeconds);
  /** 按状态机混合 fly/glide。@returns {Map<number, {rot:[x,y,z,w], pos:[x,y,z]}>} */
  export function sampleDragonPose(animations, t);
  // dragon-renderer.js
  export class DragonRenderer {
    constructor(scene, asset);          // asset = loadDragonAsset() 的结果
    sync(dragonEntity, nowMs);          // 无实体 → visible=false；有 → 更新 pose + 骨骼 + 红闪
    dispose();
    get mesh();                          // 供测试读 visible / geometry / skeleton
  }
  ```

- [ ] **Step 1: 写渲染层纯逻辑失败测试 `src/tests/test-dragon-render.js`**

```js
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { DragonRenderer } from '../render/dragon-renderer.js';
import { sampleDragonAnim, sampleDragonPose } from '../render/dragon-model.js';
import { DRAGON_ANIM } from '../entities/dragons/dragon-config.js';

// fixture 用的最小 asset（不 fetch 产物 → 单测不依赖烘焙；真实产物由 Tier 4 覆盖）
function miniAsset() { /* 2 骨骼 + 1 盒 + fly/glide 各 2 帧，形状与真产物一致 */ }

test('龙渲染: 无实体时 mesh.visible = false（draw call 归零）', () => {
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, miniAsset());
  r.sync(null, 0);
  assertFalse(r.mesh.visible);
  r.dispose();
});

test('龙渲染: 有实体时 visible = true 且位置来自 state', () => {
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, miniAsset());
  r.sync({ id: 'dragon-altar', state: { position: [10, 30, 20], yaw: 1.2, flashedUntil: 0 } }, 0);
  assertTrue(r.mesh.visible);
  assertEqual(r.mesh.position.x, 10);
  assertEqual(r.mesh.position.y, 30);
  assertEqual(r.mesh.position.z, 20);
  r.dispose();
});

test('龙渲染: 骨骼数与产物一致，且几何属性齐全', () => {
  const scene = new THREE.Scene();
  const a = miniAsset();
  const r = new DragonRenderer(scene, a);
  assertEqual(r.mesh.skeleton.bones.length, a.bones.length);
  for (const attr of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight'])
    assertTrue(r.mesh.geometry.getAttribute(attr) !== undefined, `缺 ${attr}`);
  assertEqual(r.mesh.geometry.getAttribute('skinWeight').array.every(v => v === 1 || v === 0), true);
  r.dispose();
});

test('龙渲染: 红闪期内材质偏红，到期复位', () => {
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, miniAsset());
  const st = { position: [0, 30, 0], yaw: 0, flashedUntil: 1000 };
  r.sync({ id: 'd', state: st }, 500);      // nowMs < flashedUntil → 红
  assertTrue(r.mesh.material.color.r > r.mesh.material.color.g, '红闪期应偏红');
  r.sync({ id: 'd', state: st }, 1500);     // 到期 → 白
  assertEqual(r.mesh.material.color.getHex(), 0xffffff);
  r.dispose();
});

test('龙动画采样: 时刻 0 与一个周期后逐位相同（loop）', () => {
  const a = miniAsset().animations;
  const s0 = sampleDragonPose(a, 0);
  const s1 = sampleDragonPose(a, DRAGON_ANIM.cycleSeconds);
  for (const [k, v] of s0) {
    const w = s1.get(k);
    for (let i = 0; i < 4; i++) assertTrue(Math.abs(v.rot[i] - w.rot[i]) < 1e-9, `rot[${i}] ${v.rot[i]} vs ${w.rot[i]}`);
  }
});

test('龙动画采样: 淡入期返回两个动画的混合（blend 真的生效）', () => {
  const a = miniAsset().animations;
  const tMid = DRAGON_ANIM.flySeconds + DRAGON_ANIM.blendSeconds / 2;
  const pure = sampleDragonAnim(a.fly, DRAGON_ANIM.flySeconds % a.fly.frameCount / a.fly.fps);
  const mixed = sampleDragonPose(a, tMid);
  // 混合值必须严格落在两个纯值之间（不等于任一端）
  let differs = 0;
  for (const [k, v] of mixed) {
    const p = pure.get(k);
    if (p && Math.abs(v.rot[0] - p.rot[0]) > 1e-9) differs++;
  }
  assertTrue(differs > 0 || mixed.size === 0, 'blend 未生效（混合值等于纯 fly）');
});
```

⚠️ **`miniAsset()` 的形状必须与真产物逐字段一致**（AGENTS.md：fake 必须建模真实对象的副作用，不能只是形状一致）。在 `index.html` 注册。

- [ ] **Step 2: 跑测试验证 RED**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写 `dragon-model.js`**

- `loadDragonAsset()`：`fetch(resourceUrl('assets/dragon/dragon.json'))` → `json()`；贴图**不在这里加载**（渲染器用 `TextureLoader`，同 `zombie-skin-texture.js`）。⚠️ **禁止站点根绝对路径字面量**（`check:arch` 的 `[资源 URL]` 零白名单拦截）。
- `sampleDragonAnim(anim, timeSeconds)`：`f = timeSeconds × anim.fps`；`i0 = floor(f) % frameCount`、`i1 = (i0+1) % frameCount`、`frac = f − floor(f)`；对每个 `boneIndices[k]` 读两帧的 7 个数，**四元数 slerp**（`frac`）+ **position lerp**，返回 `Map<boneIndex, {rot, pos}>`。
  ⚠️ slerp 手写（同构层不 import three）：标准四元数 slerp，`dot < 0` 时取反一端，`|dot| ≈ 1` 时退化 lerp。
- `sampleDragonPose(animations, t)`：`dragonAnimStateAt(t)`（Task 4 的纯函数）→ `blend === 0` 时只采 primary；否则两个都采，按 `blend` 混合（rot slerp / pos lerp）。

- [ ] **Step 4: 写 `dragon-renderer.js`**

- 构造期：
  - 建 `THREE.Bone` 数组（`localPosition` → `bone.position.set(...)`；`bindQuaternion` → `bone.quaternion.set(...)`），按 `parentIndex` 挂层级；
  - 建 `BufferGeometry`：`position`/`normal`/`uv` 从产物，`skinIndex`（`Uint16BufferAttribute`, itemSize 4）、`skinWeight`（`Float32BufferAttribute`, itemSize 4，**运行时生成**：每顶点 `[1,0,0,0]`）、`setIndex`；
  - `THREE.SkinnedMesh(geometry, material)` + `mesh.add(rootBone)` + `mesh.bind(new THREE.Skeleton(bones))`；
  - 材质：`MeshBasicMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide })`。
    ⚠️ **unlit**（与丧尸/矿车/海面同口径 —— 本仓灯光只为 PBR 武器而设，受光材质会吃 2.3 环境光漂移）。
    ⚠️ **`DoubleSide` 是必需的**：翼膜是 1px 薄片（spec §2.1），单面会从下方看穿。
    ⚠️ **`alphaTest: 0.5`**：贴图 57% 透明（翼膜镂空），走 cutout 语义免透明排序。
  - 纹理：`new THREE.TextureLoader().loadAsync(resourceUrl('assets/dragon/dragon.png'))`，`colorSpace = SRGBColorSpace`、`magFilter/minFilter = NearestFilter`、`generateMipmaps = false`（像素风，同丧尸皮肤口径）。
    ⚠️ **`flipY` 保持默认 `true`** —— 烘焙期的 v 轴换算就是按这个前提做的（Task 1 Step 4）。
  - `mesh.visible = false`（初始无龙）；`mesh.frustumCulled = true`（默认）。
- `sync(entity, nowMs)`：
  - `entity == null` → `mesh.visible = false; return;`（**draw call 归零**，M6 口径）
  - 否则 `visible = true`；`mesh.position.set(...state.position)`；
    `mesh.rotation.set(0, state.yaw, 0)` 后**叠加内倾 bank**：`mesh.rotateZ(DRAGON.bankRoll)`（局部轴，盘旋恒内倾；⚠️ 不得混进 `state.yaw` —— 那会改水平朝向，同玩家晃动的 roll 教训）；
  - 采样 `sampleDragonPose(asset.animations, state.orbitT)` → 逐骨骼写 `bone.quaternion.copy(bindQuat).multiply(deltaRot)`、`bone.position.copy(bindPos).add(deltaPos)`；
    ⚠️ **必须先存 bind 值再叠加**（增量语义，spec §2.2）：构造期把每骨骼的 bind `quaternion`/`position` 快照进数组，每帧从快照起算，否则增量会逐帧累积。
  - 红闪：`nowMs < state.flashedUntil` → `material.color.setHex(0xff6666)`，否则 `0xffffff`。
    ⚠️ **时间基准 `performance.now()`**（`Date.now()` 会让判定恒真 → 永久红闪，AGENTS.md 已记该坑）。
- `dispose()`：geometry/material/texture 各自 dispose，从 scene 摘除。
- ⚠️ **不回写 state、不参与命中**（命中唯一真相 = `dragonDefinition.raycastAabb`，红线 6）。文件头注释照 `zombie-renderer.js` 的序言写明「只读 pose 的受控发布层」。

- [ ] **Step 5: 跑测试验证 GREEN**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS（6 条新用例全绿）。

- [ ] **Step 6: 写 Tier 4 fixture `src/tests/test-dragon-render.html`**

照 `src/tests/test-zombie-model.html` 的手法：黑背景隔离、暴露 `renderView(name)` 让 spec 每次调用后立刻截图（一个相机只能看一个方向，多次渲染会互相覆盖）。

- import map 写 `../../vendor/three/...`（fixture 页恒比仓库根深 2 层，AGENTS.md v1.87 约束）。
- 用**真实产物**（`loadDragonAsset()` + 真实贴图），不用 miniAsset。
- 暴露：
  - `renderView('front')` / `('side')` / `('below')`：相机分别放在龙的 −Z（正前方，看头）/ +X（侧面，看翼展）/ 下方（看翼膜双面）；
  - `renderAt(t)`：把 `orbitT` 设成 `t` 后渲染一帧（供动画差异比对）；
  - `renderFlash()`：`flashedUntil` 设成未来后渲染；
  - `hide()`：`sync(null, 0)` 后渲染。
- ⚠️ **取样点用世界坐标算**（按产物 bbox），不硬编码像素（模型尺寸一改取样点自动跟着走，同 zombie fixture 口径）。

- [ ] **Step 7: 写 Tier 4 spec `tests/dragon-render.spec.mjs`**

```js
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';

// 判据全部走像素（Tier 4：单测测不到 TSL/GPU 求值结果）
test('龙渲染: 正面视图有龙头，且眼睛在预期侧（面序映射的判据）', async ({ browser }) => {
  // ① 非背景像素占比 > 阈值（龙真的画出来了）
  // ② 眼睛像素：素材贴图的眼睛区在头部，若面序映射错，眼睛会出现在侧面/顶面
  //    判据 = 正面视图里「眼睛色」像素的 bbox 必须落在头部 bbox 内（水平居中、靠上）
});
test('龙渲染: 侧面视图翼展宽度量级正确（≈16.5 格的投影）', async ({ browser }) => { ... });
test('龙渲染: 下方视图翼膜可见（DoubleSide 生效）', async ({ browser }) => {
  // 判据 = 从下方看，翼膜区域非背景像素 > 阈值；注入 side: FrontSide 后应真 FAIL
});
test('龙渲染: 贴图上下方向正确（flipY 判据）', async ({ browser }) => {
  // 判据 = 头部区域采样到的颜色应接近贴图头部区的均值，而不是脚/尾区的均值
  // ⚠️ 这条是 Review Focus 第 2 条的落点（AGENTS.md 已记两次 flipY 坑）
});
test('龙渲染: 相邻两帧像素变化 > 阈值（动画在动）', async ({ browser }) => { ... });
test('龙渲染: fly 段与 glide 段采样像素不同（状态机真的切了）', async ({ browser }) => { ... });
test('龙渲染: 红闪帧整体偏红', async ({ browser }) => { ... });
test('龙渲染: hide() 后画布与纯黑背景逐位相同（visible=false 生效）', async ({ browser }) => { ... });
```

⚠️ **写断言前先在真实数据上跑一次、打印实际值**（AGENTS.md 铁律：两处阻断缺陷均为「断言描述想象中的世界」）。每条用例先 `console.log` 实测读数，再定阈值，阈值须落在「正确实现」与「注入缺陷」两侧实测值之间。
⚠️ **测「画面是否在动」时，隐藏 HUD 后只能 `waitForTimeout`，绝不能 `await requestAnimationFrame`**（AGENTS.md v2.14 实测：在 `page.evaluate` 里 await rAF 会让后续截图恒为同一帧，`changed = 0.00%`）。
⚠️ **先测噪声底**（同状态重复截图的变化占比），非零时按噪声底调阈值。

- [ ] **Step 8: 跑 Tier 4 + 负向验证**

Run: `npx playwright test tests/dragon-render.spec.mjs --reporter=line`
Expected: PASS（8 条全绿）。

负向验证（逐个注入，确认**真 FAIL**，撤销用 `cp` 副本）：

| 注入 | 预期红的用例 |
|---|---|
| `faceMap` 的 `east`/`west` 对调 | 「眼睛在预期侧」 |
| 烘焙的 v 轴不翻转（`v_three = v_px ÷ size`）→ 重烘 | 「贴图上下方向正确」 |
| `side: THREE.FrontSide` | 「下方视图翼膜可见」 |
| `sync` 里去掉 `visible = false` 分支 | 「hide() 后逐位相同」 |
| 骨骼增量不从 bind 快照起算（逐帧累积） | 「相邻两帧变化」会异常放大 / 龙逐渐散架 |

- [ ] **Step 9: 提交**

```bash
git add src/render/dragon-model.js src/render/dragon-renderer.js src/tests/test-dragon-render.js src/tests/test-dragon-render.html src/tests/index.html tests/dragon-render.spec.mjs
git commit -m "feat(dragon): SkinnedMesh 渲染层（骨骼层级 + 动画采样 + 红闪）与 Tier 4 像素实测"
```

---

### Task 8: Game 装配 + E2E

**Tier:** 1（接线机制）+ 4（真游戏页像素/行为）

**Files:**
- Modify: `src/core/game.js`（import / 构造 / 帧循环 / `start()` 的 hydrate）
- Create: `tests/dragon.spec.mjs`（真游戏页 E2E）

**Interfaces:**
- Consumes: Task 4/5 的 `dragonDefinition` / `DragonService` / `DRAGON_TYPE`；Task 7 的 `DragonRenderer` / `loadDragonAsset`；Task 6 的 `damageEntity` / `WEAPON_HITTABLE_TYPES`
- Produces: `window.__MC_GAME__.dragons`（DragonService 实例，供 E2E 编程驱动）

- [ ] **Step 1: 接线 `game.js`**

⚠️ **顺序是载荷性的**（AGENTS.md M7 教训：controller 接线必须在 `_waitForColumn` 之前，否则 `onColumnReady` 跑时它还是 null）：

1. **import 段**：`dragonDefinition` / `DragonService` / `DRAGON_TYPE`（from `../entities/dragons/dragon-system.js` 与 `dragon-config.js`）、`DragonRenderer` / `loadDragonAsset`（from `../render/dragon-*.js`）、`WEAPON_HITTABLE_TYPES`（from `../entities/entity-types.js`）。
2. **`start()` 的 service 装配段（`this.zombies` 同段，`game.js:572` 附近）**：
   ```js
   this.entities.registerType(DRAGON_TYPE, dragonDefinition);
   this.dragons = new DragonService({
     entities: this.entities, persistence: this.persistence, seed: this.seed, world: this.world,
   });
   this.dragons.hydrate(meta);   // meta 在 :447-451 已读，构造后立即恢复死亡标记
   ```
   ⚠️ **位置约束**（实测 `start()` 的顺序）：必须在 `this.persistence = new Persistence()`
   （:447）与 `this.seed = meta.seed`（:451）**之后** —— 否则拿到 null persistence 与
   未定 seed；必须在 `_waitForColumn`（:769）**之前** —— 同 M7 巢穴/炮塔的装配约束
   （出生点 column 在 `_waitForColumn` 时 ready，`onColumnReady` 随之触发，晚于它的
   装配会让回调跑时 service 还是 null）。龙的 `ensure()` 本身在帧循环里跑、不依赖
   `onColumnReady`，但 service 实例必须在任何读它的接线之前存在。
3. **渲染装配段**（atlas/武器之后）：
   ```js
   const dragonAsset = await loadDragonAsset();
   this.dragonRenderer = new DragonRenderer(this.scene, dragonAsset);
   ```
   ⚠️ **加载失败不得让整个游戏起不来**：`try/catch` 后 `this.dragonRenderer = null`，帧循环判空（龙是景观，缺它不该白屏）。
4. **帧循环**（M5 帧序内）：
   - `entities.update` **之前**：`this.dragons.ensure();`（与 `this.zombies.update(dt, …)` 同段 —— 「先编排后推进」）
   - `entities.update` **之后**：`this.dragonRenderer?.sync(this.dragons.active(), nowMs);`
   - ⚠️ **`entities.update` 的 context 不需要加龙**（`dragonDefinition.update` 不读 context）。
5. **`dispose()`**：`this.dragonRenderer?.dispose(); this.dragons.dispose();`

   ⚠️ **不需要在 `_discardEdits()` 里清死亡标记**：`newWorld` / `clearSave` / `importProgress`
   三条路径都是 `_discardEdits()` 后紧跟**整页 reload**（`location.assign` / `location.reload`，
   `game.js:1755/1767`）→ 新页面重建 DragonService，拿到新 seed 与不含 `dragonDead` 的新 meta
   （`saveMeta` 整行 put 不传该字段 → 自然作废，与 v2.29 `playerPos` 同一机制）。
   且 `saveDragonDead` 只在死亡时调一次、**不挂 `beforeunload`** → 无「旧世界标记写回新世界」
   的竞态（playerPos 需要 `_lastSavedPos = null` 是因为它有 unload 写盘，龙没有）。

- [ ] **Step 2: 写 E2E `tests/dragon.spec.mjs`**

```js
import { test, expect } from 'playwright/test';

// ⚠️ 必须从玩家真实入口验证（AGENTS.md M7 教训：只测 API 会漏「面板/武器没接线」）
test('龙 E2E: 传送到祭坛地带后天上有一条龙', async ({ page }) => {
  await page.goto('/?vd=8');
  // ⚠️ `worldReady` 是**属性**不是方法（既有 spec 口径：teleport.spec.mjs:14 的 READY）
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 走真实按钮（不是本地调 applyStructuresToColumn）—— M7 教训：RPC 丢字段只有真按钮能验
  // ⚠️ **前提：必须从初始出生点（City）按「高台」** —— `teleportToTarnZone()` 用的是
  //    `findNearestTarnZone(玩家位置, seed)`，而龙用的是 `findAltarTarnRegion(seed)`
  //    （从 City 出生点找最近）。两者同源（AGENTS.md v2.30 活跃约束）仅当玩家从 City
  //    按按钮时成立。若先传送到别处再按，可能落到**非祭坛地带** → 用例假失败。
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
  await page.locator('#btn-teleport-tarn').click();
  await expect(page.locator('#mc-toast')).toContainText(/已瞬移到高台地带/, { timeout: 15_000 });
  // v2.28：跳转成功 100ms 后面板自动关
  await expect(page.locator('#settings-modal')).toBeHidden();
  await page.waitForFunction(() => window.__MC_GAME__.dragons?.active() !== null, null, { timeout: 30_000 });
  const s = await page.evaluate(() => {
    const g = window.__MC_GAME__, e = g.dragons.active();
    return { pos: [...e.state.position], health: e.state.health, type: e.type };
  });
  expect(s.type).toBe('dragon');
  expect(s.health).toBe(300);
  // 位置在祭坛地带上空：y ≈ 30（±bob 1.5），水平距地带中心 = 24
  expect(s.pos[1]).toBeGreaterThan(26);
  expect(s.pos[1]).toBeLessThan(34);
  const center = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    // 地带中心从 gen 层权威读（不自己写一份「哪个地带」）
    return g.dragons.active().state.orbit ? [g.dragons.active().state.orbit.cx, g.dragons.active().state.orbit.cz] : null;
  });
  expect(center).not.toBeNull();
  const r = Math.hypot(s.pos[0] - center[0], s.pos[2] - center[1]);
  expect(Math.abs(r - 24)).toBeLessThan(1e-6);
});

test('龙 E2E: 用枪打龙会掉血并红闪（走真实武器路径，非直接调 damage）', async ({ page }) => {
  // setTestAim 瞄准龙 → fireWeaponOnce() → 断言 health 下降 + flashedUntil 被置
  // ⚠️ 不得直接调 g.dragons.damage()（那验不到 predicate 与 damageEntity 的接线）
});

test('龙 E2E: 打到死后实体消失且 dragonDead 落库，刷新页面不复活', async ({ page }) => {
  // damage 到 0 → active() === null → 读 IndexedDB meta.dragonDead === true
  // → page.reload() → 等 worldReady → active() 仍为 null（永久死亡）
});

test('龙 E2E: 炮塔能索敌到龙（targets 接线）', async ({ page }) => {
  // 在龙轨道下方放炮塔 → 等索敌周期 → 断言 controller.targetId === 'dragon-altar'
  // ⚠️ 受 ±45° 俯仰限制：炮塔必须放在水平距离 ≥23.7 格处（spec §6.2 实测表）
});

test('龙 E2E: 玩家走远再回来，龙重生（column 卸载回收后 ensure 复活）', async ({ page }) => {
  // 传送到远处 → 等 column 卸载 → 传送回祭坛地带 → active() !== null
  // ⚠️ 这是 Review Focus 第 4 条的落点：形态与「永久死亡」无法区分，必须显式验
});

test('龙 E2E: 换 seed 后龙恢复（死亡标记随世界作废）', async ({ page }) => {
  // 打死龙 → 验证 meta.dragonDead === true → 换 seed → 新世界里龙恢复
  // ⚠️ 导航监听必须在触发 reload **之前**武装（clear-save.spec.mjs:97 实测竞态：
  //    waitForLoadState('load') 写在 click/evaluate 之后会看到「当前页已是 load 态」立即返回，
  //    随后 READY 在**旧页**上本就为真 → 全部等待瞬间通过 → 读到旧世界）。
  // ⚠️ 既有手法（m3-hud.spec.mjs:160）：直接 `g.newWorld(null)`（整页 reload，带新 ?seed=），
  //    不必点 `#btn-new-world` 按钮（那条路径只是包一层）。
  const nav = page.waitForLoadState('load');
  await page.evaluate(() => window.__MC_GAME__.newWorld(null));
  await nav;
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 新 seed 的祭坛地带重新生成 → 龙恢复（TARN_ZONE_CHANCE=1/5 × 扫描 33×33 region，
  // 「全世界无地带」的概率 ≈ (4/5)^1089 ≈ 0，不需为它写分支）
  await page.waitForFunction(() => window.__MC_GAME__.dragons?.active() !== null, null, { timeout: 30_000 });
});

test('龙 E2E: reload 后龙的位置仍是纯函数派生（persistent: false 的判据）', async ({ page }) => {
  // 记录位置 → reload → 等重生 → 位置在同一轨道上（半径 24、y ≈ 30）
  // ⚠️ 这条拓「误传 persistent: true」（Task 5 Step 6 里单测抓不到的那一条）
});
```

⚠️ **E2E 里所有「等地带/等 column」都要用 `waitForFunction`**，不能 `waitForTimeout` 拍脑袋（AGENTS.md：`_teleportTo` 刻意不等 column 加载）。
⚠️ **验「相机跟到了」必须先关面板**（设置面板是模态，主循环跳过 `player.update`）。v2.28 起跳转成功后面板会自己关 → 用 `expect(#settings-modal).toBeHidden()` 等它关。

- [ ] **Step 3: 跑 E2E 验证 RED→GREEN**

Run: `npx playwright test tests/dragon.spec.mjs --reporter=line`
Expected: 接线前 FAIL（`g.dragons` undefined）；接线后 PASS（7 条全绿）。

⚠️ 若「传送到祭坛地带后天上有一条龙」超时：先查 `ensure()` 的 column 就绪门控（`hasColumn(floor(cx/16), floor(cz/16))`）—— 传送后玩家位置变了，但**龙的 column 门控读的是祭坛中心**，玩家必须在加载半径内。`?vd=8` 下传送过去后该 column 会就绪；若仍不 spawn，打印 `findAltarTarnRegion(seed)` 与 `world.hasColumn` 的实际值定位（**不要猜**）。

- [ ] **Step 4: 负向验证**

| 注入 | 预期红的用例 |
|---|---|
| `game.js` 的 `damageEntity` 改回 `this.zombies.damage` | 「用枪打龙会掉血」 |
| `setEntityQuery` 不注入 `isHittable` | 「用枪打龙会掉血」（predicate 缺省只认 zombie） |
| `spawn` 传 `persistent: true` | 「reload 后位置仍是纯函数派生」（会读到存档里的旧位置） |
| 帧循环去掉 `dragons.ensure()` | 「走远再回来龙重生」+「传送后有一条龙」 |
| `_updateTurrets` 不并入龙 | 「炮塔能索敌到龙」 |
| `saveMeta` 的整行 put 里带上 `dragonDead: true`（或 `saveDragonDead` 挂进 `beforeunload`） | 「换 seed 后龙恢复」（旧标记写进新世界） |

- [ ] **Step 5: 跑全量回归 + 提交**

```bash
npm run check
npm test
```
Expected: 全绿。

⚠️ **三条计时型 spec 在高负载下偶发贴线 flaky**（AGENTS.md：`m1-acceptance` / `m3-rain` / `weapons-world-edit`）。若阻断，**先做交替对照**（MOD/BASE 交错各 3 轮比中位），不要看单次数值，也不要放宽阈值。
⚠️ **龙新增 1 个 draw call（有龙时）** → 若 `bench --check` 的场景 ④ draw 门禁报回退，那是**预期代价**（同 v1.42 天空树 +15、M6 丧尸 +6 的先例）。按 AGENTS.md 口径：交替对照确认增量真实后，**重标基线**而不是放大容差（用户已裁定该口径）。⚠️ 不带 `--check` 跑 bench 会自动重写 `docs/m3-baseline.*`（冻结基线），诊断后须 `git checkout` 恢复。

```bash
git add src/core/game.js tests/dragon.spec.mjs
git commit -m "feat(dragon): Game 装配龙服务与渲染器，E2E 覆盖射击/死亡/重生/炮塔索敌"
```

---

### Task 9: 文档同步

**Tier:** 3（文档）—— 免测试，但每条声明必须能从代码/产物重新推导（AGENTS.md：inherited text is untrusted input）。

**Files:**
- Modify: `docs/roadmap.md`（v2.41 行 + 「后续扩展点」表若有相关条目）
- Modify: `AGENTS.md`（现状段加 v2.41 + 新增「祭坛之龙沉淀的活跃约束」小节 + 目录结构清单 + 开发命令清单）
- Modify: `docs/superpowers/specs/2026-11-03-altar-dragon-design.md`（若实施中有偏离，补修订说明）

**Interfaces:**
- Consumes: Task 1~8 的实测数据
- Produces: 文档

- [ ] **Step 1: 更新 `docs/roadmap.md`**

加 v2.41 行：改动摘要 + **实测数据**（产物度量：115 元素 / 78 骨骼 / 2760 顶点 / fly 36 帧 / glide 90 帧；draw call 增量；E2E 用例数）。

⚠️ **用例计数不硬编码**（AGENTS.md：以 `npm run check:data` 输出为准，同一事实的多个副本属「改动放大器」）。

- [ ] **Step 2: 更新 `AGENTS.md`**

1. **现状段**加 v2.41 一句（与其它版本行同格式）。
2. **新增「祭坛之龙沉淀的活跃约束」小节**，至少覆盖这些**实施中实测到的**载荷性结论（照既有小节的写法：每条都带「为什么」与「失效形态」）：
   - SkinnedMesh 在 WebGPU 后端可用（附探针实测读数），故 115 盒合并成 1 个 draw call；
   - 素材的骨骼 `origin` 是绝对坐标、元素自身旋转全 0、每元素刚性归属单骨骼（→ skinWeight 恒 1）；
   - **UV 递减书写不得规范化**（同 MC 皮肤版式陷阱）；
   - **v 轴 flipY 换算与 `TextureLoader` 的 `flipY=true` 是一对耦合约定**，调试探针必须走真实加载路径（`DataTexture` 会给出假结论）；
   - **翼膜 1px 薄片必须 `DoubleSide`**；
   - 骨骼增量必须从 **bind 快照**起算（否则逐帧累积 → 龙散架）；
   - 龙是**临时实体**（`persistent: false`）+ 死亡标记走 `meta.dragonDead` merge 写 —— 位置进存档违反红线 2；
   - **column 卸载回收 → `ensure()` 重生**，代价是血量重置（用户已知悉）；
   - 伤害路由的唯一收敛点 = `Game.damageEntity`；`WEAPON_HITTABLE_TYPES` 是三处 predicate 的唯一权威；
   - `computeTurretUpdates` 的参数已从 `zombies` 改名 `targets`，每项可带 `bodyOffsetY`（龙传 0，因为它的 position 是身体中心）；
   - 炮塔 ±45° 俯仰的可达性实测表（spec §6.2）；
   - `DRAGON_ORBIT_SALT = 1040`（1028 虽空闲但属被跳过的洞，保守避开）；
   - 轨道半径 24 的净空推导（翼尖 32.25 < 高台最近格 34.5）。
3. **目录结构清单**：`assets/dragon/`、`tools/bake-dragon.mjs`、`tools/dragon-fingerprint.mjs`、`src/entities/dragons/`、`src/render/dragon-model.js`、`src/render/dragon-renderer.js`。
4. **开发命令清单**：`npm run dragon`（含「不跑则产物静默过期」的警告，与其它烘焙命令同格式）。

⚠️ **不复制进度表**（AGENTS.md 自身规则：同一事实的多个副本会漂移）。

- [ ] **Step 3: 逐条重新推导文档里的每个数值**

对 Step 1/2 写下的每个数字，从代码或产物重新算一遍（`node -e` 读产物 / grep 常量）。**推导不出来的删掉，不要软化成「大约」**（AGENTS.md 验证节）。

- [ ] **Step 4: 跑最小门 + 提交**

```bash
npm run check
git add docs/roadmap.md AGENTS.md docs/superpowers/specs/2026-11-03-altar-dragon-design.md
git commit -m "docs(dragon): 祭坛之龙落地记录与活跃约束"
```

---

## Self-Review 记录

**1. Spec 覆盖**（逐节对照）：

| spec 节 | 落点 |
|---|---|
| §2 素材事实 | Task 1（几何/UV/贴图）、Task 2（动画） |
| §4 资产管线 | Task 1 + Task 2 + Task 3（门禁） |
| §5.1 dragon-config | Task 4 |
| §5.2 DragonService | Task 5 |
| §5.3 伤害路由泛化（5 处） | Task 6 |
| §6.1 轨道公式 | Task 4 |
| §6.2 高度与净空 | Task 4（常量）+ Task 8（E2E 炮塔用例的摆放约束） |
| §6.3 动画状态机 | Task 4（纯函数）+ Task 7（采样） |
| §7 渲染层 | Task 7 |
| §8 Game 装配 | Task 8 |
| §9 测试策略 | Tier 1 → Task 2/4/5/6；Tier 2 → Task 3；Tier 4 → Task 7/8 |
| §10 有意偏离 | Task 9（写进 AGENTS.md 活跃约束） |
| §11 风险 1（面序映射） | Task 7 Step 7 用例 ① + Step 8 负向验证 |
| §11 风险 2（catmullrom） | Task 2 Step 1 的两条断言 |
| §11 风险 3（position 语义） | Task 6 Step 4 的 JSDoc 要求 + Task 6 Step 1 的 bodyOffsetY 用例 |

无遗漏。

**2. Step 扫描**：每步都是一个动作 + 可检查结果。代码步只给签名与 spec 钉住的确切值，函数体留给实施者（例外：`saveDragonDead` 与 `damageEntity` 给了完整体，因为它们是「merge 写」与「类型分发」两个**语义易错点**，spec 已固定其形状）。

**3. 类型一致性**：`dragonPoseAt(orbit, t)` / `dragonAnimStateAt(t)` / `dragonAabbFor(state)` / `sampleDragonPose(animations, t)` / `DragonService.{ensure,damage,active,isDead,hydrate,dispose}` / `DragonRenderer.{sync,dispose,mesh}` / `damageEntity(id, amount, nowMs)` / `computeTurretUpdates({turrets, targets, world, registry})` —— 跨任务引用已逐一核对，无形近名异。

**4. Review Focus**：五条都在 owning task 里有对应测试（见各条末尾的 `→` 指向）。

**5. 比例**：spec 448 行，本计划 1508 行 / 9 个任务。代码块主要是**测试断言**（TDD 的 RED 判据）与**确切常量值**，不是实现体 —— 符合「计划是实施者无法独自做出的决策集合」。比例偏大的原因是本仓的测试纪律要求每条断言都带「为什么这个阈值」与负向验证表（AGENTS.md / testing-policy 的既有口径），而不是实现细节被写进了计划。

**6. 自审期间修正的错误**（都是「凭印象写接口」，已逐个 grep 核实）：

| 错误 | 真相 | 修正 |
|---|---|---|
| `REGION_SIZE` 在 `src/voxel/constants.js` | 在 `src/gen/structures/region-config.js`；且 DragonService 根本不需要它 | 删除该引用 |
| `controller.tryFireEntityHit()` | 无此方法；真实链是 `fireOnce` → `_tryFire` → `_fireHitscan` → `_queryEntityHit` | 改为 `select('pistol')` + `fireOnce(aim)` |
| `worldReady()` 是方法 | 是**属性**（`game.js:220/923`，既有 spec 写 `=== true`） | 改为属性读 |
| `makeController()` | 真实名是 `makeControllerFixture()`（`test-weapons.js:40`） | 改名 |
| E2E 用 `page.click('#settings-btn')` | 既有手法是 `page.locator(...).click()` + toast 断言（`teleport.spec.mjs`） | 改为既有手法 |
| 自己拼 `${Math.floor(cx/16)},${...}` | `columnKeyAt` 是唯一权威（`constants.js:52`） | 改为调它 |
| `_discardEdits()` 里 hydrate 清死亡标记 | `newWorld`/`clearSave` 都是**整页 reload**（`game.js:1755/1767`）→ 多余 | 删除，改为注释说明为何不需要 |
| 装配位置写「Player 构造之前」 | 真实约束是「`persistence`(:447)/`seed`(:451) 之后、`_waitForColumn`(:769) 之前」，`this.zombies` 在 :572 | 改为带行号的精确约束 |
| 「无祭坛地带」用例的 column 集合用对角线 400 个键 | 那样拓不到「地带缺失」而只拓到「column 未就绪」 | 改为 `hasColumn: () => true` |
