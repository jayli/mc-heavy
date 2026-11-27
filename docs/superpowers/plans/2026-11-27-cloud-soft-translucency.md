# 云方块半透光观感（云专属着色地板）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `cloud` 方块的背光面/底面/凹角不再死暗（顶/底屏幕亮度比 1.559 → 1.165），而亮面逐位不动、阴影与玩法零变更。

**Architecture:** 给云的三个致暗因子（太阳项 / 半球环境 / AO）各加一个**地板**，用 `max(原值, 地板)` 抬升暗面 —— 原值已高于地板的面 `max` 恒等返回，故亮面结构性不动、无需重标定强度。逐 quad 标记走 `packed` **bit19**（空闲位，零新增顶点属性）；地板由当前 per-style 的 `shadowFloor`/`hemiGround` 派生，故五档风格自动跟随。

**Tech Stack:** three r185.1 WebGPU + TSL（`vendor/three/`，import map）、Node v26 单测（`tools/three-resolver.mjs` 提供 three 解析映射）、Playwright + pngjs 像素门。

**Spec:** `docs/superpowers/specs/2026-11-27-cloud-soft-translucency-design.md`

## Global Constraints

- 依赖方向单向 `voxel ← gen ← mesh ← render`；`src/mesh/mesher.js` **不得 import three、不得引用 DOM**（红线 8，`check:arch` 静态门）。
- 新模块 `src/render/cloud-shade.js` **不 import 任何东西**（避免 `daynight ↔ sun-shade` 那类循环初始化，已实测 ReferenceError）。
- shade 必须在**顶点阶段**算成 float 经 float varying 传片元（红线 11；int varying 被 three 强制 flat）。
- **零产物改动**：不跑任何烘焙命令（atlas / icons / structures / water 全部不动），全部指纹不变。
- **不改** `cloud` 的 `solid` / `cullMode` / `opaqueTable` / `shadowCast` / `supportsPlayer` 声明（`src/voxel/blocks-data.js:44` 一个字节不动）。
- **不改**巨型云结构的材质映射（`tools/cloudland-kit-fingerprint.mjs` 的 `BLOCK_MAP`、`tools/bake-cloudland-kit.mjs` 的 `restyleCloud` 全部不动）。
- TSL 七条口径（`src/render/wet-surface.js` 文件头）：节点不与裸 JS 数字算术（一律 `.mul()/.add()/.sub()/.div()`）；常量色显式拆分量；多层 mix 嵌套不链式；径向量在片元算；**不用 `.toVar()/.assign()`**（`makeMaterial` 里直接调，无 stack）；反向 smoothstep 写 `oneMinus(smoothstep(...))`；噪声用 `mx_noise_float`。
- 开关一律 `mix()` 插值，**不写 `if` 分支**（`uCloudSoften = 0` 必须逐位回到现状）。
- 中文注释；不加 inline 英文注释、不加版权头。
- 每个 Task 结束跑 `npm run check`（5.4s）。**不跑 `npm test`** —— 本改动不是全局基础设施，最小充分集在结构上成立（理由见 spec §6.6）。
- 测试命令**不接管道**（`| tail` 会把退出码换成管道末端工具的）。预计 >1min 的命令用 `run_in_background`。
- 负向验证注入用 `edit`（不用 `sed`，后者静默不匹配），注入后**读回源码确认落地**，还原用 `cp` 副本（**禁止 `git checkout`/`restore`**）。

## Review Focus

按 spec 逐节核对后，以下五类最可能咬人而单任务测试不天然覆盖 —— 每条已指派到 owning task：

1. **非云方块被误抬亮**（bit19 若写成「整个 opaque 通道置位」，全世界的背光面都变亮，而云自己的判据全绿）→ Task 2 Step 1 的判别性用例（stone/snow/marble/leaves 逐顶点 bit19=0）+ Task 4 判据③（石头板顶底都逐位不变）。
2. **整体提亮冒充柔和**（改系数或 wrap lighting 会让顶面一起变亮，云底面判据仍绿）→ Task 4 判据②（云顶面比值 ∈ [0.99,1.01]）+ Task 5 负向②（注入加法后判据②必须真红）。
3. **bit19 挤占既有位段**（挤进 bit14 会让云开始投影，挤进 bit15-18 会翻转湿表面分类；方块层面看不出错）→ Task 2 Step 1 第 **2** 条（cloud 的 bit0–18 语义逐项不变）。
4. **`vBlockShade` 漏改**（只抬 `vSkyShade` 会让火把照亮的云凹角与太阳照亮的不一致，户外测不出来）→ Task 3 Step 1 的源码级断言（两个 varying 都必须吃 `aoSoft`）。
5. **云地板与 per-style 地板撕裂**（云地板若在 `daynight._apply` 里重新读一遍 `p.shadowFloor` 而非复用局部量，normal 档下两者不同步；两个端点一致而中间调撕裂，全部「地板值对不对」的判据全绿）→ Task 3 Step 1 的源码级断言（`_apply` 里云地板必须吃 `floor`/`ground` 局部量）+ Task 1 Step 1 第 6 条（normal 档派生值）。

---

### Task 1: `cloud-shade.js` 纯函数模块（常量 + CPU 参考实现）

**Files:**
- Create: `src/render/cloud-shade.js`
- Create: `src/tests/test-cloud-shade.js`
- Modify: `tools/test-tiers.mjs`（`UNIT_NODE_SAFE` 数组，加 `'test-cloud-shade.js'`）
- Modify: `src/tests/index.html`（在 `import './test-hemi.js';` 那行之后加一行 import）

**Interfaces:**
- Consumes: 无（本模块零 import）
- Produces:
  ```ts
  export const CLOUD_SUN_LIFT: number   // 0.35
  export const CLOUD_HEMI_LIFT: number  // 0.50
  export const CLOUD_AO_LIFT: number    // 2/3
  export const AO_CURVE_K: number       // 0.9
  export function aoFactorFor(ao: number): number
  export function cloudSunFloorFor(floor: number, lift?: number): number
  export function cloudHemiFloorFor(ground: number, lift?: number): number
  export function cloudAoFloorFor(lift?: number): number
  export function cloudShadeFor(o: {
    normalIndex: number, ao: number, sunDir: readonly number[], shadowKill: number,
    shadowFloor: number, sunIntensity: number, hemiGround: number, soften: number,
  }): number
  ```
  Task 2 不用本模块（mesher 只认方块名）；Task 3 用三个 `*FloorFor` 做 uniform 初值；Task 4 用 `cloudShadeFor` 标定阈值。

- [ ] **Step 1: 写失败测试**

Create `src/tests/test-cloud-shade.js`。用既有 runner/assert（照 `src/tests/test-hemi.js` 的 import 形式）：
```js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
```
七组用例，名字与断言如下（值全部来自 spec §5.1/§6.1，已 CPU 预跑）：

1. `'cloud-shade: lift=0 时三个地板逐位等于原值（零回归锚点）'`
   对 `floor ∈ [0.38, 0.14, 0.2713]`、`ground ∈ [0.6, 0.12, 0.4319]`：
   `assertEqual(cloudSunFloorFor(floor, 0), floor)`、`assertEqual(cloudHemiFloorFor(ground, 0), ground)`、
   `assertEqual(cloudAoFloorFor(0), aoFactorFor(0))`（**用 `assertEqual` 严格相等，不用容差** —— 这条钉的是逐位）。

2. `'cloud-shade: ao=3 时 AO 地板不改开阔面'`
   `assertEqual(Math.max(aoFactorFor(3), cloudAoFloorFor()), aoFactorFor(3))`；
   并 `assertEqual(aoFactorFor(3), 1)`（前提断言：开阔面本就恒 1）。

3. `'cloud-shade: 正午顶面 sunTerm 恒 1.0 且高于云地板 ⇒ max 恒等（顶面不动）'`
   从 `../render/sun-shade.js` import `SHADOW_FLOOR, SUN_INTENSITY, NOON_SUN_DIR`，
   算 `st = SHADOW_FLOOR + SUN_INTENSITY * NOON_SUN_DIR[1]`；
   `assertTrue(Math.abs(st - 1) < 1e-12)`、`assertTrue(st >= cloudSunFloorFor(SHADOW_FLOOR))`、
   `assertEqual(Math.max(st, cloudSunFloorFor(SHADOW_FLOOR)), st)`。

4. `'cloud-shade: soften=0 逐位等于现状公式（非整比输入，7776 组）'`
   遍历 `sunDir ∈ [[0.3187,0.8721,-0.3719], [-0.4412,0.6633,0.6047], [0.7934,0.5479,0.3392], [0,0.8,0.6]]`（各自归一化）
   × `shadowFloor ∈ [0.38, 0.14, 0.2713]` × `hemiGround ∈ [0.6, 0.12, 0.4319]`
   × `sunIntensity ∈ [0.775, 0.956, 0.6173]` × 6 面 × `ao ∈ [0,1,2,3]` × `shadowKill ∈ [1, 0.3719, 0]`。
   参考值在测试里**独立算**（不 import 被测函数）：
   `(floor + I*dot*kill) * (ground + (1-ground)*(ny/2+0.5)) * (1 - (3-ao)/3*0.9)`。
   `assertEqual(cloudShadeFor({...soften: 0}), ref)` 逐组严格相等。
   ⚠️ 循环里累计一个 `checked` 计数，末尾 `assertEqual(checked, 7776)` —— 防「循环没跑」的恒真。

5. `'cloud-shade: soften=1 时暗面变亮、亮面逐位不变、任何面都不变暗'`
   正午常量（floor 0.38 / ground 0.6 / I 0.775 / sunDir [0,0.8,0.6] / kill 1），6 面 × ao ∈ [0,1,2,3] = 24 组：
   分类计数 `brighten` / `unchanged` / `dimmed`，断言 `assertEqual(brighten, 20)`、
   `assertEqual(unchanged, 4)`、`assertEqual(dimmed, 0)`。
   并单独钉住：`normalIndex=2`（顶面）与 `normalIndex=4`（+Z 迎光面）在 `ao=3` 时 `unchanged`。

6. `'cloud-shade: 地板随 floor/ground 单调，且 normal 档派生值正确'`
   `assertTrue(cloudSunFloorFor(0.14) < cloudSunFloorFor(0.38))`（同 lift 下 floor 越大地板越大）；
   `assertEqual(cloudSunFloorFor(0.14), 0.441)`（浮点用 `assertTrue(Math.abs(v-0.441)<1e-12)`）、
   `cloudHemiFloorFor(0.12) ≈ 0.56`、`cloudAoFloorFor() ≈ 0.7`；
   normal 档顶面：`st = 0.14 + 0.956 * (0.5479/Math.hypot(0.7934,0.5479,0.3392))`，
   断言 `Math.max(st, cloudSunFloorFor(0.14)) === st`（normal 档顶面也不动）。

7. `'cloud-shade: soften=0 与 sun-shade/hemi-shade 的既有公式交叉一致（不留第二份公式）'`
   import `sunTermRGBFor` from `../render/sun-shade.js`、`hemiFactorFor` from `../render/hemi-shade.js`；
   对 6 面 × ao ∈ [0,1,2,3]，用 `sunTermRGBFor(i, NOON_SUN_DIR, 1, 1)[0] * hemiFactorFor(i, HEMI_GROUND) * aoFactorFor(ao)`
   作参考，`assertTrue(Math.abs(cloudShadeFor({...soften:0}) - ref) < 1e-12)`。
   ⚠️ 这里用容差而非严格相等：两个模块的乘法**顺序**不同（交叉一致性判据，不是逐位判据；逐位那条在用例 4）。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-cloud-shade.js`
Expected: FAIL —— `Cannot find module .../src/render/cloud-shade.js`（模块还不存在）。

⚠️ 该命令会因「文件不在 `UNIT_NODE_SAFE` 白名单」而先报错。**先做 Step 3 的登记部分**
（`tools/test-tiers.mjs` + `index.html` 两处），再跑本步 —— 否则看到的 RED 是白名单错而不是模块缺失，
那是假 RED（testing-policy §2.7「注入未生效」同源）。

- [ ] **Step 3: 登记 + 实现模块**

先登记（两处，缺一不可 —— `check:data` 的 `[测试分档]` 门双向钉住）：
- `tools/test-tiers.mjs` 的 `UNIT_NODE_SAFE` 数组里加 `'test-cloud-shade.js'`（放在 `'test-hemi.js'` 附近，保持字母序习惯）；
- `src/tests/index.html` 在 `import './test-hemi.js';` 之后加 `import './test-cloud-shade.js';`。

再 Create `src/render/cloud-shade.js`，签名见 Interfaces。实现要点（签名与测试已定的不重复）：
- 文件头注释说明：为什么单独成模块（零 import 断环）、三个 lift 的语义（0=不抬 / 1=完全不致暗）、
  以及**为什么用 `max` 而不是改系数**（改系数会动亮面 ⇒ 过曝 + 撞 crosshair 阈值）。
- `cloudShadeFor` 里地板走 `原值 + (地板 − 原值) × soften` 再 `Math.max` —— **与 TSL 的 `mix` 同形**，
  这样 `soften=0` 的逐位性在两侧同源（已预验 `mix(a,b,0)===a`）。
- `aoFactorFor` 的 `AO_CURVE_K` 是本模块导出常量；`materials.js` 现状写的是字面量 `0.9`，
  Task 3 会把它换成 import 本常量（红线 1：不留第二份）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-cloud-shade.js`
Expected: PASS，7 例全绿。

Run: `npm run check`
Expected: exit 0（`[测试分档]` 门认得新文件）。

- [ ] **Step 5: Commit**

```bash
git add src/render/cloud-shade.js src/tests/test-cloud-shade.js tools/test-tiers.mjs src/tests/index.html
git commit -m "feat: 云着色地板的纯函数模块与不变式单测"
```

---

### Task 2: mesher 写 packed bit19

**Files:**
- Modify: `src/mesh/mesher.js`（`SHADOW_CAST_BIT` 常量附近加 `CLOUD_SOFT_BIT`；逐方块常量段 `:574-579`；立方体分支 `packeds.push` `:734`）
- Test: `src/tests/test-mesher.js`（在既有 bit14 用例之后追加）

**Interfaces:**
- Consumes: 无（mesher 只认方块名 `'cloud'`，不 import `cloud-shade.js` —— 那会引入 mesh→render 反向依赖）
- Produces: `packed` 的 **bit19** = 「这一格是云」。Task 3 用 `packed.shiftRight(19).bitAnd(1)` 解包。

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-mesher.js` 既有 `const NO_SHADOW_CAST_BIT = (1 << 14);` 之后加
`const CLOUD_SOFT_BIT = (1 << 19);`，并追加三条用例（复用既有 `makeRegistry()` / `meshSingle(reg, name)`）：

1. `'mesher: cloud 置 bit19（云专属着色），stone/snow/marble/leaves 不置'`
   cloud 走 `result.opaque`；leaves 走 `result.cutout`（它 `cullMode:'cutout'`）；
   stone/snow/marble 走 `result.opaque`。逐顶点 `assertEqual((packed[i] & CLOUD_SOFT_BIT) ? 1 : 0, 期望)`。
   ⚠️ **这条是判别性用例**：实现若写成「整个 opaque 通道置位」，stone/snow/marble 三条真红。
   ⚠️ 每个方块先 `assertTrue(vertexCount > 0)`（前提断言：防「零顶点时循环不跑」的恒真）。

2. `'mesher: cloud 的 bit19 不污染 bit0-18（位段隔离）'`
   cloud 逐顶点：`(packed[i] & 0xFF) === 0xF0`（light）、`((packed[i] >>> 8) & 3) <= 3`（AO）、
   `((packed[i] >>> 10) & 7) <= 5`（face）、`((packed[i] >>> 13) & 1) === 0`（非自发光）、
   `((packed[i] >>> 14) & 1) === 1`（**不投影，语义未动**）、`((packed[i] >>> 15) & 0xF) === 0`（wetClass NONE）。
   手法与 `src/tests/test-wet-surface.js:202` 同款。

3. `'mesher: bit19 只对 cloud 置位 —— 与方块名双向一致（全 registry 扫描）'`
   遍历 `reg.count` 个方块，对每个能产出顶点的方块 mesh 一次，
   断言 `(bit19 ? 1 : 0) === (reg.nameOf(id) === 'cloud' ? 1 : 0)`。
   ⚠️ 跳过零顶点的方块（`cullMode:'none'` 的 air/collider 等），但**累计一个 `checked` 计数并断言 > 100**
   （防「全部跳过」的恒真）。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-mesher.js`
Expected: FAIL —— 三条新用例的第 1 条报 `cloud vert0 bit19 期望 1 实测 0`。

- [ ] **Step 3: 实现**

在 `src/mesh/mesher.js`：
- `const SHADOW_CAST_BIT = 1 << 14;` 之后加 `const CLOUD_SOFT_BIT = 1 << 19;`，
  注释写明：消费方是 `materials.js` 的三个着色地板；**为什么用名字而不是新声明字段**
  （与 `SAME_TYPE_CULL`/`EMISSIVE_MATERIALS`/`DOUBLE_SIDE_CUBES` 同为材质语义，
  `blocks-data.js` 是 mc-lite `BlockData.js` 的转换产物，不长渲染专用列）；
  **bit19 不得挤占 bit0–18**（挤 bit14 会让云开始投影）。
- 逐方块常量段（`noShadowCastBit` / `wetClassBits` 那一处）加
  `const cloudSoftBit = blockName === 'cloud' ? CLOUD_SOFT_BIT : 0;`
- **只改立方体分支**的 `packeds.push(...)`，末尾 `| cloudSoftBit`。
  ⚠️ 模板分支（`:655`）**不改** —— `cloud` 的 `geometry:'box'` 不在 `TEMPLATES` 里（Node 实测 keys 无 box/cube），
  那里没有云，加了是死代码。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-mesher.js`
Expected: PASS（既有全部用例 + 3 条新用例）。

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: PASS（位段隔离的邻居用例，证明 bit19 没挤占 wetClass）。

Run: `npm run check`
Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add src/mesh/mesher.js src/tests/test-mesher.js
git commit -m "feat: mesher 为 cloud 写 packed bit19（云专属着色标记）"
```

---

### Task 3: materials 三个着色地板 + daynight 派生写入

**Files:**
- Modify: `src/render/materials.js`（import 段；`aoFactor` `:37`；`vSkyShade`/`vBlockShade` `:48-49`；`hemiFactor` `:121`；`sunTerm` `:197`；`makeMaterial` 的 `shadeLit` `:199`；返回值 `dayNight` 与新增 `cloud`）
- Modify: `src/render/daynight.js`（`_apply` 的 `:671-676` 段）
- Test: `src/tests/test-cloud-shade.js`（追加源码级断言，手法照 `test-wet-surface.js:357`）

**Interfaces:**
- Consumes: Task 1 的 `cloudSunFloorFor` / `cloudHemiFloorFor` / `cloudAoFloorFor` / `AO_CURVE_K`；Task 2 的 packed bit19
- Produces:
  ```ts
  // createVoxelMaterials 返回值新增：
  cloud: {
    uCloudSoften: UniformNode<number>,     // 初值 1.0
    uCloudSunFloor: UniformNode<number>,   // 初值 cloudSunFloorFor(SHADOW_FLOOR) = 0.597
    uCloudHemiFloor: UniformNode<number>,  // 初值 cloudHemiFloorFor(HEMI_GROUND) = 0.800
    uCloudAoFloor: UniformNode<number>,    // 初值 cloudAoFloorFor() = 0.700
  }
  // dayNight 对象里也加 uCloudSoften（与既有 uHemiGround 并列）
  ```
  Task 4 经 `g.renderWorld.materials.cloud.uCloudSoften.value` 写 0/1 做单变量 A/B。

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-cloud-shade.js` 追加四条**源码级**断言（Node 侧读源码，不 import TSL ——
手法与 `test-wet-surface.js` 的 `'wet class: GPU 侧索引必须钳到表长 − 1'` 完全一致：
读文件 → **滤掉 `*` / `//` / `/*` 开头的注释行** → 正则匹配代码行。
⚠️ 不滤注释会恒真：jsdoc 里有同串公式说明）：

1. `'materials: AO 地板同时作用于 vSkyShade 与 vBlockShade（漏一个会让火把照亮的云凹角不一致）'`
   断言两个 varying 的 `vertexStage(mul(..., aoSoft))` 都吃 `aoSoft`，
   且**不存在** `vertexStage(mul(sky, aoFactor))` / `vertexStage(mul(block, aoFactor))` 的旧写法。
   （Review Focus 第 4 条）

2. `'materials: 三个地板都走 mix 且 t 含 cloudBit × uCloudSoften（无 if 分支）'`
   断言存在三处 `mix(` 且各自的 t 参数含 `uCloudSoften`；
   断言代码行里**没有** `if (cloudBit` 这类分支。

3. `'materials: 云地板加在 sunTerm 之后（不是 vSunDot 上 —— 否则改阴影语义）'`
   断言 `uCloudSunFloor` 出现在 `const sunTerm = ` 之后的代码里，
   且 `vSunDot` 的定义式里**不含** `uCloudSunFloor`。（Review Focus 第 5 条的另一半）

4. `'daynight: 云地板复用 floor/ground 局部量（不重新读 p，防 per-style 撕裂）'`
   读 `src/render/daynight.js`，断言存在 `cloudSunFloorFor(floor)` 与 `cloudHemiFloorFor(ground)`，
   且**不存在** `cloudSunFloorFor(typeof p.` / `cloudSunFloorFor(p.shadowFloor` 这类重新读的写法。
   （Review Focus 第 5 条）

另加一条**句柄形状**用例（Node 侧可 import —— `tools/three-resolver.mjs` 提供 three/tsl 映射，
`test-wet-surface.js:214` 已有先例）：
5. `'cloud uniforms: 句柄形状与初值（uCloudSoften=1 满档；三个地板等于派生值）'`
   **直接 import 模块顶层导出的 `CLOUD_SURFACE_UNIFORMS`**（Step 3 会把它定义成
   `export const CLOUD_SURFACE_UNIFORMS = { uCloudSoften: uniform(1.0), ... }`，
   与 `src/render/wet-surface.js:81` 的 `WET_SURFACE_UNIFORMS` 逐字同款）。
   不走 `createVoxelMaterials` —— 它要 atlasTexture，Node 侧构造成本高且无必要。
   模块顶层单例同时保证**反射替身自动共享**（`render-world.js:203`）。
   断言：`uCloudSoften.value === 1`、`uCloudSunFloor.value === cloudSunFloorFor(SHADOW_FLOOR)`、
   `uCloudHemiFloor.value === cloudHemiFloorFor(HEMI_GROUND)`、`uCloudAoFloor.value === cloudAoFloorFor()`。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-cloud-shade.js`
Expected: FAIL —— 第 1 条报「两个 varying 必须吃 aoSoft」（源码还是旧写法）。

- [ ] **Step 3: 实现 materials.js**

- import 段加 `import { AO_CURVE_K, cloudSunFloorFor, cloudHemiFloorFor, cloudAoFloorFor } from './cloud-shade.js';`
  （`SHADOW_FLOOR` / `HEMI_GROUND` 已 import）。
- 模块顶层新增四个 uniform 并**导出为 `CLOUD_SURFACE_UNIFORMS`**（与 `WET_SURFACE_UNIFORMS` 同款手法）：
  `uCloudSoften = uniform(1.0)`、`uCloudSunFloor = uniform(cloudSunFloorFor(SHADOW_FLOOR))`、
  `uCloudHemiFloor = uniform(cloudHemiFloorFor(HEMI_GROUND))`、`uCloudAoFloor = uniform(cloudAoFloorFor())`。
  ⚠️ **必须放模块顶层**：反射替身由同一个 `createVoxelMaterials` 造（`render-world.js:203`），
  模块级单例 ⇒ 替身自动跟随，无需同步。
- `const cloudBit = float(packed.shiftRight(19).bitAnd(1));`（与 `noShadowCastBit` 同款解包），
  `const cloudT = mul(cloudBit, uCloudSoften);`
- **AO**：`aoFactor` 的字面量 `0.9` 换成 `AO_CURVE_K`（红线 1）；之后加
  `const aoSoft = mix(aoFactor, max(aoFactor, uCloudAoFloor), cloudT);`
  `vSkyShade` / `vBlockShade` **两项都**改吃 `aoSoft`。
- **半球**：`hemiFactor` 之后加 `const hemiSoft = mix(hemiFactor, max(hemiFactor, uCloudHemiFloor), cloudT);`
- **太阳项**：`const sunTerm = ...` 之后加 `const sunTermSoft = mix(sunTerm, max(sunTerm, uCloudSunFloor), cloudT);`
- `shadeLit` 改吃 `hemiSoft` 与 `sunTermSoft`；**`shadeUnlit` 只改 `hemiSoft`**（它不含太阳项；
  且 transparent 通道没有云 ⇒ 该项恒等，改它只为口径一致）。
- 返回值：`dayNight` 里加 `uCloudSoften`；新增 `cloud: CLOUD_SURFACE_UNIFORMS`。
- ⚠️ 全部在**顶点阶段**（`aoSoft`/`hemiSoft` 已是顶点量；`sunTermSoft` 吃 `vSunDot` varying，
  与既有 `sunTerm` 同一求值点）。⚠️ 不用 `.toVar()/.assign()`；节点不与裸数字算术。

- [ ] **Step 4: 实现 daynight.js**

`_apply` 的 `:671-676` 段：把两个内联三元提成局部 `const floor` / `const ground`，
既有三行改吃它们（**值逐位不变**），再加两行云地板写入（句柄缺失时跳过，与 `uShadowFloor` 同一容错口径）。
`uCloudAoFloor` 与 style 无关 ⇒ `_apply` **不写**。
import 段加 `cloudSunFloorFor` / `cloudHemiFloorFor`（`cloud-shade.js` 零依赖，不成环）。

- [ ] **Step 5: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-cloud-shade.js`
Expected: PASS（Task 1 的 7 例 + 本任务 5 例）。

Run: `node tools/run-unit-node.mjs --only=test-daynight.js,test-sun-shade.js,test-hemi.js`
Expected: PASS（per-style 写入的邻居用例；证明提成局部量后四档值逐位不变）。

Run: `npm run check`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add src/render/materials.js src/render/daynight.js src/tests/test-cloud-shade.js
git commit -m "feat: 云专属着色地板接线（三个 max + per-style 派生）"
```

---

### Task 4: Tier 4 像素门 `cloud-softness.spec.mjs`

**Files:**
- Create: `tests/cloud-softness.spec.mjs`
- Modify: `tools/test-tiers.mjs`（`PIXEL` 数组加 `'cloud-softness'`）

**Interfaces:**
- Consumes: Task 3 的 `g.renderWorld.materials.cloud.uCloudSoften`；Task 1 的 `cloudShadeFor`（仅用于注释里记标定来源，spec 不 import src 模块 —— 照既有 Tier 4 spec 的做法）
- Produces: 无（终端产物）

- [ ] **Step 1: 写 spec（四条判据 + sanity floor）**

Create `tests/cloud-softness.spec.mjs`。**夹具照抄 `tests/hemisphere-ambient.spec.mjs` 已验证的口径**，
逐项复用（不重造）：
- URL `'/?vd=4&seed=12345&style=noon&weather=clear'`；
- `waitWorldSettled`（等 `worldReady` + sections 停止增长 + 五个队列归零）；
- `regionLuma(png, cx, cy, r)`（三通道均值，r=6）；
- 取样点由**真实 `camera.project`** 算（不写死屏幕坐标）；
- 光源手动摆到被测物上方（`g.sunLight.position/target` + `shadow.needsUpdate = true`）——
  理由见那个 spec 的文件头：阴影相机居中到玩家，悬空板在视锥外；
- 隐藏全部 HUD（`#hud-root > *`、`#crosshair`、`#settings-btn`）+ `g.pushModal(...)`；
- `g.camera.up.set(0,0,-1)` 避开 lookAt 退化（俯视/仰视时 up 与视线平行）。

几何：**两块 13×13×2 悬空厚板**，y = P..P+1（P=80），水平错开到互不遮挡且都入画：
cloud 板中心 `(ox, oz)`、stone 板中心 `(ox + 20, oz)`。清空两板上方的云/空岛/建筑。
⚠️ 同机位同法线下「云 vs 石头」是**单变量对照** —— 避免 `wet-surface.spec` 记的
「不同法线下 N·L 造出亮度差，分类完全退化也全绿」那个盲区。

四个机位：云顶（俯视 cloud 板）、云底（仰视 cloud 板）、石头顶、石头底。
唯一变量 `uCloudSoften` 0↔1，每次写后 `g.renderer.render(g.scene, g.camera)` + `waitForTimeout(400)`。

判据（**四条同时成立**，缺一条就有恒真路径）：
```js
// ① 云底面显著变亮
expect(botCloudOn / botCloudOff).toBeGreaterThan(1.15);
// ② 云顶面逐位不变（正向对照：证明不是整体提亮）
expect(topCloudOn / topCloudOff).toBeGreaterThan(0.99);
expect(topCloudOn / topCloudOff).toBeLessThan(1.01);
// ③ 石头板顶面与底面都逐位不变（证明 bit19 没误置到整个通道）
expect(Math.abs(topStoneOn - topStoneOff)).toBeLessThan(1.0);
expect(Math.abs(botStoneOn - botStoneOff)).toBeLessThan(1.0);
// ④ sanity floor：四支读数都是几何，且云顶 ≠ 云底
for (const v of [topCloudOff, botCloudOff, topStoneOff, botStoneOff]) {
  expect(v).toBeGreaterThan(20); expect(v).toBeLessThan(185);
}
expect(Math.abs(topCloudOff - botCloudOff)).toBeGreaterThan(5);
```
⚠️ **①的 1.15 是待标定的初值，②③④是不变式**（testing-policy §2.6 第⑤条）：
Step 2 先只跑 sanity floor + 打印八支读数，Step 3 才把①②③加回并按实测定①的下界。
spec §3.1 的 CPU 表（顶/底 1.559→1.165）是**标定起点，不是最终阈值** ——
真实机位有额外衰减（crosshair 实测 181 vs CPU 226）。
**若实测与 CPU 表方向相反或差异 >30%，停下来报告，不擅自改断言。**

登记：`tools/test-tiers.mjs` 的 `PIXEL` 数组加 `'cloud-softness'`（带一行注释说明它守什么）。

- [ ] **Step 2: 先量真实机位的实际值（不先写阈值）**

首版 spec 只带 `console.log('CLOUD-SOFTNESS:', JSON.stringify({...八支读数}))` 与 **sanity floor ④**，
①②③ 先不写断言（只打印比值）。

Run: `npx playwright test tests/cloud-softness.spec.mjs`
Expected: PASS（只有 sanity floor），且 stdout 里能看到 `CLOUD-SOFTNESS:` 那行的八支读数。

⚠️ 若 sanity floor FAIL（读数 <20 或 >185，或云顶≈云底）⇒ **夹具错了**：修几何/机位，
不要放宽 sanity floor（它是防「取到天空/黑屏时判据恒真」的唯一护栏）。

⚠️ **实测与 CPU 表方向相反或差异 >30% 时停下来报告**（testing-policy 的冻结纪律）——
那意味着测量方法或实现有问题，不是阈值需要调。参系：spec §3.1 的顶/底 1.559→1.165。
真实机位有额外衰减（crosshair 实测 181 vs CPU 226），故**绝对值允许偏低，比值方向不得反**。

- [ ] **Step 3: 按实测写①的下界，并验证三条不变式真的成立**

把①②③的断言加回（代码见 Step 1）。①的下界取**实测比值略下方**（留量化余量）；
若实测比值远低于 1.15（例如只有 1.05），**不得直接降到 1.02 让它绿** ——
先查是不是三个地板没真的上屏（读 `uCloudSunFloor.value` 等三个 uniform 的实际值）。
②③④是**不变式**，不得为了让测试通过而放宽。

Run: `npx playwright test tests/cloud-softness.spec.mjs`
Expected: PASS。

Run: `npm run check`
Expected: exit 0（`[测试分档]` 门认得新 spec）。

- [ ] **Step 4: Commit**

```bash
git add tests/cloud-softness.spec.mjs tools/test-tiers.mjs
git commit -m "test: 云柔和化的 Tier 4 像素门（四条判据 + sanity floor）"
```

---

### Task 5: 负向验证（两条，必需）

**Files:**
- Modify: `tests/cloud-softness.spec.mjs`（追加两条负向用例）
- 临时注入：`src/mesh/mesher.js` / `src/render/materials.js`（**用 `cp` 副本还原，禁止 `git checkout`**）

**Interfaces:**
- Consumes: Task 4 的夹具与判据
- Produces: 无

- [ ] **Step 1: 负向① —— bit19 恒 0 ⇒ 判据①必须真 FAIL**

在 spec 里加 `'负向①：mesher 不给 cloud 置 bit19 ⇒ 云底面变亮判据必须 FAIL'`。
用 `page.route` 在**浏览器侧**换内容（照 `wet-surface.spec.mjs` 的 `routeModule`，
**必须在 `goto` 之前注册**，否则注入静默失效）：
把 mesher 源码里 `blockName === 'cloud' ? CLOUD_SOFT_BIT : 0` 换成 `false ? CLOUD_SOFT_BIT : 0`。
`routeModule` 自带「模式未命中就 throw」的守卫。

注入后**读回浏览器侧源码确认落地**：
```js
const src = await (await fetch('/src/mesh/mesher.js')).text();
// 只扫代码行（滤掉 * 与 // 开头）—— 全文件 includes 会因注释恒真
```
断言注入串存在、原串已消失。然后跑与正向**同口径**的采样，断言
`expect(botCloudOn / botCloudOff).toBeLessThan(1.02)`（注入后云底面不该再变亮）。

⚠️ 这条用例的 PASS 意味着「缺陷被抓到」—— 它断言的是**注入后判据失效**，
不是「注入后功能仍正常」。命名与注释要写清这个方向，否则后人会读反。

- [ ] **Step 2: 负向② —— 整体提亮 ⇒ 判据②必须真 FAIL**

加 `'负向②：把 max 换成加法（整体提亮）⇒ 云顶面不变判据必须 FAIL'`。
`page.route` 把 materials 的 `mix(sunTerm, max(sunTerm, uCloudSunFloor), cloudT)`
换成 `sunTerm.add(uCloudSunFloor.mul(cloudT).mul(0.3))`（顶面也被抬 ⇒ 整体提亮）。
读回确认注入落地（只扫代码行）。
断言 `expect(Math.abs(topCloudOn / topCloudOff - 1)).toBeGreaterThan(0.01)`
（注入后顶面**必须**变 ⇒ 证明判据②不是恒真）。

- [ ] **Step 3: 跑两条负向**

Run: `npx playwright test tests/cloud-softness.spec.mjs`
Expected: PASS（正向 + 两条负向全绿）。

⚠️ 若某条负向 PASS 但读回显示注入**没落地** ⇒ 那是假绿，修注入模式（用 `edit` 精确匹配，不用 `sed`）。

- [ ] **Step 4: Commit**

```bash
git add tests/cloud-softness.spec.mjs
git commit -m "test: 云柔和化的两条负向验证（bit19 恒 0 / 整体提亮）"
```

---

### Task 6: 消费方回归 + 热路径 bench + 文档

**Files:**
- Modify: `docs/roadmap.md`（加 v3.49 行）
- Modify: `docs/pitfalls.md`（**只在实测踩到新坑时**追加；否则不动）

**Interfaces:**
- Consumes: Task 1–5 的全部产物
- Produces: 无

- [ ] **Step 1: 跑消费方 spec（最小充分集）**

改 mesher + materials + daynight ⇒ 经 `game.js` 装配段消费它们的 spec。
用 `run_in_background`（预计 >1min），**不接管道**：

```bash
npx playwright test tests/wet-surface.spec.mjs tests/hemisphere-ambient.spec.mjs \
  tests/sun-directional.spec.mjs tests/crosshair.spec.mjs \
  tests/normal-style.spec.mjs tests/sun-shadow.spec.mjs
```

Expected: 全绿。逐条的**预期理由**（FAIL 时按此定位，不要盲目放宽）：
- `wet-surface`：云区判据是「`uWet` 0↔1 时云区不变」。本改动不动 `uWet`，且两次采样都在
  `uCloudSoften=1` 下 ⇒ 云区仍逐位不变 ⇒ 应绿。若红，查是否误把云地板接进了 wet 分支。
- `hemisphere-ambient` / `sun-directional`：都用 `stone`（bit19=0）⇒ 逐位不变 ⇒ 应绿。
  若红，查 `cloudT` 是否在非云方块上真的恒 0。
- `crosshair`：亮面不动 ⇒ 「最亮方块 < 200」应绿。若红，说明实现动了亮面（`max` 写成了加/改系数）。
- `normal-style`：四档零回归判据是「切到 normal 再切回 noon 逐位相同」。本改动对两档都生效
  且是对称的 ⇒ 应绿。若红，查 `_apply` 是否漏写某个地板（切档残留）。
- `sun-shadow`：阴影语义未动（bit14 与 `maskShadowNode` 都没碰）⇒ 应绿。

⚠️ 已知 flaky（`m3-rain` 截图差分 / bench frameP95 / `m1-acceptance` 放挖 p95）**不在本集合里**。
若本集合里出现计时型失败，用**交替对照**定性（改动侧与 HEAD 副本交错各 2~3 轮），
**不改阈值**（testing-policy §2.3）。

- [ ] **Step 2: 跑热路径 bench**

碰了 mesher / materials ⇒ 必须跑（testing-policy §6.1）。用 `run_in_background`（~5min）：

```bash
npm run bench -- --check
```

Expected: exit 0（回退 >10% 才报 1）。
⚠️ **`npm run bench` 不带 `--check` 会重写冻结基线 `docs/m3-baseline.*`** —— 必须带 `--check`。
⚠️ frameP95 有 vsync 量子化噪声（已记在 pitfalls）：若单项 frameP95 报回退，
用交替对照判定而非单次测量，**不改阈值**。
⚠️ bench **不可与回归 spec 并发**（争 GPU）—— Step 1 结束后再跑。

- [ ] **Step 3: 跑 Node 轻档全量**

```bash
npm run test:unit
```
Expected: PASS（104+1 文件）。这一步覆盖「新模块有没有弄坏别的纯函数用例」。

- [ ] **Step 4: 写文档**

`docs/roadmap.md` 加 v3.49 行，按既有格式（版本 / 标题 / 状态 / 详述）写：
用户原话与三条裁定、**「云本来就不投影」这个纠正**（附取证链）、
三个地板的派生值与 CPU 实测表（顶/底 1.559→1.165、亮面逐位不动）、
巨型云仍 61.4% 表面未覆盖（范围裁定）、零产物改动、实际跑过的门禁与读数。
状态标 `📝 代码已完成（**待用户实玩验收**）`。

`docs/pitfalls.md`：只在 Step 1/2 或负向验证里**真的踩到新坑**时追加一节（写清「已被实测推翻的写法」）。
没踩到就不动 —— 不为凑数写推测性条目。

- [ ] **Step 5: 核对并提交**

```bash
git status --short
```
Expected: 只有本 Epic 的文件（`src/render/cloud-shade.js`、`src/mesh/mesher.js`、
`src/render/materials.js`、`src/render/daynight.js`、`src/tests/test-cloud-shade.js`、
`src/tests/test-mesher.js`、`src/tests/index.html`、`tests/cloud-softness.spec.mjs`、
`tools/test-tiers.mjs`、`docs/roadmap.md`、`docs/pitfalls.md`、两份设计/计划文档）。
⚠️ **`docs/m3-baseline.*` 不得出现在改动里**（那意味着跑了不带 `--check` 的 bench）。
⚠️ **`AGENTS.md` 是 `CLAUDE.md` 的符号链接** —— 本轮不改规范，不涉及。

```bash
git add docs/roadmap.md docs/superpowers/specs/2026-11-27-cloud-soft-translucency-design.md docs/superpowers/plans/2026-11-27-cloud-soft-translucency.md
git commit -m "docs: 云半透光观感的设计文档、实施计划与 roadmap v3.49"
```
（`docs/pitfalls.md` 若有改动一并 add。）

---

## 交付后的开放项（不在本计划范围）

- **巨型云剩余 61.4% 表面**（marble/clay/snow/cloth/iron）仍是硬的。扩范围的做法是
  **逐结构标记**（烘焙 stride 4→5 + `meta` bit2 + mesher 读它），不是换材质
  （换材质撞 `check-data.mjs:1842` 的 snow/sky_stone 保持不变裁定）。待用户实玩后决定。
- **柔和档位可调**：`CLOUD_SUN_LIFT` / `CLOUD_HEMI_LIFT` / `CLOUD_AO_LIFT` 三者职责分离。
  实玩觉得「云内部失去层次」⇒ 只降 `CLOUD_AO_LIFT`；觉得「还不够柔」⇒ 抬前两个。
  **它们不是冻结常量**，改后需重标 Task 4 的判据①下界（②③④是不变式，不动）。
- **`uCloudSoften` 不进面板**。若将来加开关，须遵守「翻转默认值时旧存档一起迁移」的既有裁定。