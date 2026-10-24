# 光影真实感增强 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让阳光/月光在场景中真正可见 —— 接入 ACES 色调映射、加深环境地板、扩大阴影覆盖并提清晰度、补上方向性环境光，全部落在渲染装配与着色器，不触碰任何游戏逻辑。

**Architecture:** 四项改动各自独立、互不替代：(A) `renderer.toneMapping` + 每风格 exposure 由 `DayNight._apply` 单一收口；(B) `sun-shade.js` 的 `SHADOW_FLOOR/SUN_AMBIENT` 共享常量 0.5→0.38，`SUN_INTENSITY` 派生值自动跟随（零回归不变式 `SUN_AMBIENT + SUN_INTENSITY × noonSunY ≡ 1.0` 保持）；(C) `game.js` 里 sunLight 的阴影相机 ±48 / 贴图 1024² 并通过注入的句柄向材质暴露（纹素对齐读配置，无需改）；(D) `materials.js` 新增 `uHemiGround` uniform 与 `vHemi` varying，只乘 skylight 项、不碰 blocklight。

**Tech Stack:** 纯 JavaScript ES Modules + JSDoc，three.js r185.1（本地 `vendor/three/`），WebGPU 后端，TSL（`three/tsl`）节点着色器，Playwright + pngjs 做 Tier 4 像素验收。

**Spec:** `docs/superpowers/specs/2026-10-24-lighting-realism-design.md`

## Global Constraints

- **只改配色与光影。** 地形生成、结构高度、刷怪、物理、物品集合、存档格式一律不动（用户明确约束）。
- 纯 JavaScript + JSDoc，**禁止 TypeScript**，无编译/转译/bundler。
- 体素材质是 **unlit**（`MeshBasicNodeMaterial`）——不得换成受光材质。
- **`SUN_AMBIENT ≡ SHADOW_FLOOR`** 必须恒等（同一语义的两个身份），改一处必须改另一处。
- **零回归不变式**：`SUN_AMBIENT + SUN_INTENSITY × NOON_SUN_Y ≡ 1.0`（正午顶面方向光项 = 1.0）。
- **`uSunStrength = 0` 必须让 `sunTerm ≡ 1`**（`mix(1, full, strength)`，方向不可反）。
- **`uHemiGround = 1.0` 必须让半球因子 ≡ 1**（关闭时逐位回到现状）。
- 半球因子 **只乘 skylight 项，不乘 blocklight**；太阳项同样只乘 skylight。
- 太阳项与阴影 **不接 transparent 通道**（水/玻璃）。
- 数值常量一律从配置/风格数据读，**不得在消费点写字面量**（红线 1）。
- 冻结断言重标必须用**真实页面实测值**，不得为「让测试通过」而放宽容差；重标后仍须**双侧钉住**。
- 每步验证命令按 `docs/testing-policy.md` 门禁分层选择，不为小改动跑全量。
- 中文注释；新增代码 0 ESLint error。

## Review Focus

- **`uHemiGround` 误接到太阳项上**：开发者会觉得「方向性光照」就该跟着太阳走，于是把 `hemiFactor` 乘进 `sunTerm`。后果是关闭方向光（`uSunStrength=0`）时半球差异一起消失，且夜间月光下朝下面不暗。用户预期：环境光的方向性与太阳无关，标志明确后仍生效。→ Task 4 的 Tier 1 用例钉住。
- **`shadow.radius` 随贴图分辨率变硬**：`radius` 是**纹素**单位，256²→1024² 后同样的 2.6 相当于原来的 ~1 纹素。用户已确认先接受更硬的影子，但**不能**有人后续以为是 bug 而把覆盖改回去。→ Task 3 的注释与 spec §5.2/§9 记录。
- **重标冻结断言时放宽容差**：最常见的偷懒形态是把 `toBeLessThan(1.45)` 改成 `toBeLessThan(2.0)` 这类「看着过了」。用户既有裁决是重标为实测值 + 保留余量。→ Task 6/7 每一步都要求「先打印实测值再写断言」。
- **`?shadows=0` 隔离入口不再逐位回到旧观感**：其它 spec 靠它做变量隔离。若「关阴影」时 ACES / 半球 / 地板值仍改变画面，那些 spec 的判据会失去意义。用户预期：关掉某一个因素只影响那一个因素。→ Task 2/4 的负向验证步骤。
- **ACES 让准心自适应配色漂移**：`crosshair.js` 按背景亮度切白/黑（阈值 220/200）。ACES 压亮部 → 背景变暗 → 准心更易保持白色。用户预期：准心在中灰地形上仍是白的，只有真极亮背景才转黑。→ Task 8 复跑该 spec。

---

### Task 1: 环境地板 0.5 → 0.38（`sun-shade.js`）

**Files:**
- Modify: `src/render/sun-shade.js:23`（`SHADOW_FLOOR`）
- Test: `src/tests/test-sun-shade.js:10-18,20-46`

**Interfaces:**
- Produces: `SHADOW_FLOOR = 0.38`、`SUN_AMBIENT = SHADOW_FLOOR`、`SUN_INTENSITY = (1 − SUN_AMBIENT) / NOON_SUN_Y = 0.775`（均为 `number` 导出）
- Consumes: `VISUAL_STYLES.noon.sunDirection`（既有）

- [ ] **Step 1: 改现有断言写失败测试**

在 `src/tests/test-sun-shade.js` 里把三条硬编码旧值的断言改成新目标值：

```js
test('sun-shade: SUN_AMBIENT 恒等于 SHADOW_FLOOR（同一语义：太阳被拿走后的环境地板）', () => {
  assertEqual(SUN_AMBIENT, SHADOW_FLOOR, '两个常数必须相等，否则影区与背光面亮度撕裂');
  assertEqual(SHADOW_FLOOR, 0.38, 'v1.71：用户选定 0.38 加深暗部（实测 p5 45→28）');
});

test('sun-shade: SUN_INTENSITY 由正午太阳方向派生（不是字面量）', () => {
  assertTrue(Math.abs(NOON[1] - 0.8) < 1e-12, `正午太阳方向归一化后 y 应为 0.8，实测 ${NOON[1]}`);
  assertTrue(Math.abs(SUN_INTENSITY - 0.775) < 1e-12, `派生值应为 0.62/0.8=0.775，实测 ${SUN_INTENSITY}`);
});
```

同一文件里「正午六面亮度排序」用例的第二档期望值同步更新（`+Z` 0.875 → 0.845、`±X` 0.5 → 0.38）：

```js
  assertTrue(Math.abs(v[0] - 0.38) < 1e-12, `+X 面${v[0]}（太阳 x 分量为 0 → 恒 ambient=0.38）`);
  assertTrue(Math.abs(v[4] - 0.845) < 1e-12, `+Z 面应为 0.5-0.62+0.775×0.6=0.845，实测 ${v[4]}`);
```

- [ ] **Step 2: 跑测试确认变红**

Run: 浏览器打开 `http://localhost:8081/src/tests/index.html`，Read title 后取 `window.__MC_TEST_RESULTS__`：
```js
page.evaluate(() => window.__MC_TEST_RESULTS__.suites.flatMap(s => s.tests)
  .filter(t => t.name.includes('sun-shade') && !t.passed).map(t => t.name + ': ' + t.message))
```
Expected: FAIL，`SUN_AMBIENT` 为 0.5 而期望 0.38（且 `SUN_INTENSITY` 0.625 vs 0.775）

- [ ] **Step 3: 改常量**

`src/render/sun-shade.js` 的 `SHADOW_FLOOR` 改为 0.38，并更新其 JSDoc：说明这个值不再是 mc-lite 的 0.4733 推导，而是**本仓实测标定**（v1.71 用户拍板加深暗部），保留「两个身份必须相等」的说明。

```js
export const SHADOW_FLOOR = 0.38;
```

`SUN_AMBIENT` 与 `SUN_INTENSITY` 的表达式**不动**（它们已是派生式）。

- [ ] **Step 4: 跑测试确认变绿**

Run: 同 Step 2 的命令。
Expected: `sun-shade` 全部用例 PASS（含零回归不变式「正午 +Y 面 sunTerm ≡ 1.0」）

- [ ] **Step 5: 提交**

```bash
git add src/render/sun-shade.js src/tests/test-sun-shade.js
git commit -m "feat(lighting): 环境地板 0.5→0.38 加深暗部"
```

---

### Task 2: ACES 色调映射 + 每风格 exposure

**Files:**
- Modify: `src/render/daynight.js`（`VISUAL_STYLES` 三处加字段、`lerpParams` 加插值、`_apply` 加写出）
- Modify: `src/core/game.js:114`（渲染器构造后设 `toneMapping`）、`:257` 附近（`DayNight` 构造传 `renderer`）
- Test: `src/tests/test-daynight.js`（新增两条）

**Interfaces:**
- Produces: `VISUAL_STYLES.{morning,noon,night}.toneMappingExposure`（`number`）；`DayNight` 构造器新增可选参数 `renderer`（`THREE.WebGPURenderer | null`，缺省 `null` = 不写曝光，供 stub 测试）
- Consumes: `paramsAtHour()` 的 `lerpParams` 契约（新增字段必须同时插值）

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-daynight.js` 末尾追加：

```js
test('toneMappingExposure：三风格都有且单调（夜必须补曝光）', () => {
  const m = VISUAL_STYLES[VISUAL_STYLE_KEYS.MORNING].toneMappingExposure;
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON].toneMappingExposure;
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT].toneMappingExposure;
  for (const [name, v] of [['morning', m], ['noon', n], ['night', k]]) {
    assertTrue(typeof v === 'number' && v > 0.5 && v < 2.5, `${name} exposure 须在 (0.5,2.5)：${v}`);
  }
  assertEqual(n, 1.0, 'noon 用 1.0（实测 1.25 会把天空冲到近纯白）');
  assertTrue(k > n, `夜必须比正午补更多曝光（ACES 暗部压缩陡）：night=${k} noon=${n}`);
});

test('DayNight：exposure 随关键帧插值写出（且 setStyle 走同一收口）', () => {
  const seen = [];
  const renderer = { set toneMappingExposure(v) { seen.push(+v.toFixed(4)); } };
  const { dayNight } = makeDayNightStub({ renderer });
  dayNight.setTime(12);   // noon 平台段
  dayNight.setTime(0);    // night 平台段
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON].toneMappingExposure;
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT].toneMappingExposure;
  assertTrue(seen.includes(n), `正午须写出 ${n}，实测序列 ${JSON.stringify(seen)}`);
  assertTrue(seen.includes(k), `夜里须写出 ${k}，实测序列 ${JSON.stringify(seen)}`);
  // 中间时刻必须落在两端之间（证明走的是插值而非二态）
  const mid = paramsAtHour(6).toneMappingExposure;
  assertTrue(mid >= Math.min(k, n) - 1e-9 && mid <= Math.max(k, n) + 1e-9,
    `6 点的 exposure 须在两端之间：${mid}`);
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: 同 Task 1 Step 2 的取结果命令，把过滤条件换成 `'exposure'`。
Expected: FAIL —— `undefined` 不满足 `> 0.5`

- [ ] **Step 3: 实现**

`src/render/daynight.js`：

1. 三个 `VISUAL_STYLES` 条目各加一个字段（**取值见 spec §3.1**）：`morning: 1.35`、`noon: 1.0`、`night: 1.6`。每个值旁写一行注释说明来源（morning 是 mc-lite 原值；noon/night 是本仓实测最优，见 spec §3.2/§3.3）。
2. `lerpParams` 的返回对象加 `toneMappingExposure: a.toneMappingExposure + (b.toneMappingExposure - a.toneMappingExposure) * t`。
3. `DayNight` 构造器解构参数加 `renderer = null`，存 `this.renderer = renderer`。
4. `_apply` 末尾（在 `onSunDirection` 回调之前或之后均可，但必须是单一收口点）：

```js
    // ACES 色调映射的曝光随风格/日夜插值（v1.71）。**单一收口点**：setStyle 与日夜循环
    // 两条路径都经 _apply → 口径一致。renderer 缺省 null（stub 测试 / 尚未装配）→ 跳过。
    if (this.renderer && typeof p.toneMappingExposure === 'number') {
      this.renderer.toneMappingExposure = p.toneMappingExposure;
    }
```

`src/core/game.js`：

1. 渲染器构造后立刻加（在 `await this.renderer.init()` **之前**即可，属性无 GPU 依赖）：

```js
    // ACES 色调映射（v1.71）：高光柔和滚落、不再被 sRGB 传递函数削平成白块。
    // 曝光值由 DayNight._apply 按风格/日夜写入（唯一收口点）。
    // ⚠️ v1.58 的 spec §7 曾以「用户否决」为由不移植，v1.71 用户重新拍板 → 该否决作废。
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
```

2. `new DayNight({ ... })` 的选项里加 `renderer: this.renderer,`。

- [ ] **Step 4: 跑测试确认变绿**

Run: 同 Task 1 Step 2，过滤 `'exposure'`。
Expected: 两条 PASS

- [ ] **Step 5: 负向验证（隔离入口仍逐位回到旧行为）**

用一次性探针（`tests/tmp-*.spec.mjs`，不提交）起 `/?vd=4&seed=12345&style=noon&weather=clear`，同一机位截图三态：

```js
// ① 现状（ACES 开）② 手动 toneMapping = 0（关闭）③ 再开回来
g.renderer.toneMapping = 0; g.renderer.needsUpdate = true;   // ②
```

Expected：② 的平均亮度与 `git stash` 后 HEAD 的读数**逐位相同**（证明 ACES 是纯加项、可完全关闭）；③ 与 ① 逐位相同（往返无残留）。实测值记入验收报告。

- [ ] **Step 6: 提交**

```bash
git add src/render/daynight.js src/core/game.js src/tests/test-daynight.js
git commit -m "feat(lighting): 接入 ACES 色调映射 + 每风格曝光"
```

---

### Task 3: 阴影覆盖 ±48 / 贴图 1024²

**Files:**
- Modify: `src/core/game.js:187-194`（`sunLight.shadow.mapSize` 与 `camera.{left,right,top,bottom,far}`）
- Test: `tests/sun-shadow.spec.mjs:145` 的配置断言（用例 1）

**Interfaces:**
- Consumes: 既有 `texelSnapOffset()`（读 `(right−left)/mapSize`，**无需改动** —— 纹素随配置自动变 0.094）
- Produces: 新配置 `mapSize 1024²`、`camera ±48`、`far 300`

- [ ] **Step 1: 改配置断言写失败测试**

`tests/sun-shadow.spec.mjs` 用例 1 的两行：

```js
  expect(s.mapSize).toEqual([1024, 1024]);
  expect(s.cam).toEqual({ left: -48, right: 48, top: 48, bottom: -48, near: 0.1, far: 300 });
```

并更新该用例的注释：说明 v1.71 有意扩大（实测真实场景阴影覆盖 1.19% → 3.21% 像素、纹素 0.234 → 0.094 格），
以及 **`radius` 保持 2.6 是用户拍板**（纹素变小后影子更硬，属「更像日光」的有意结果，不是回归）。

- [ ] **Step 2: 跑测试确认变红**

Run: `npx playwright test tests/sun-shadow.spec.mjs -g "接线：shadowMap"`
Expected: FAIL，`mapSize` 实测 `[256,256]`

- [ ] **Step 3: 改配置**

`src/core/game.js` 的 sunLight 构造段：

```js
    sunLight.shadow.mapSize.set(1024, 1024);
    sunLight.shadow.camera.left = -48;
    sunLight.shadow.camera.right = 48;
    sunLight.shadow.camera.top = 48;
    sunLight.shadow.camera.bottom = -48;
    sunLight.shadow.camera.near = 0.1;
    sunLight.shadow.camera.far = 300;
```

在 `mapSize` 上方补注释：扩大覆盖的理由（±30 只覆盖 60 格 → 树影建筑影多在覆盖外，实测真实场景阴影可见度仅 1.19% 像素）、
纹素随之从 0.234 变 **0.094 格（反而更清晰 2.5×）**、以及 **`radius` 保持 2.6 是用户拍板**（VSM 的 radius 是纹素单位 → 半影会变窄 2.5×，
观感更硬更锐，符合「真实感」诉求；若实玩觉得生硬，处置是按比例升到 ~6.5 的单次标定，**不得回退覆盖**）。

- [ ] **Step 4: 跑测试确认变绿**

Run: `npx playwright test tests/sun-shadow.spec.mjs -g "接线：shadowMap"`
Expected: PASS

- [ ] **Step 5: 跑阴影成本探针并记录**

写一次性探针测「刷新帧 vs 稳态帧」的 `frameP95` 分组统计（v1.44 既有手法：刷新帧只占约 4%，
落在 600 帧窗口 p95 阈值之下 → 聚合 p95 抓不到尖峰，必须按「该帧是否刷新」分组）。

Expected：刷新帧 < 11ms、稳态帧与 HEAD 逐位同级。实测值记入验收报告；若刷新帧显著恶化，停下来报告，不改判据。

- [ ] **Step 6: 提交**

```bash
git add src/core/game.js tests/sun-shadow.spec.mjs
git commit -m "feat(lighting): 阴影覆盖 ±48 + 贴图 1024²，纹素清晰度提升 2.5x"
```

---

### Task 4: 半球环境光（`materials.js`）

**Files:**
- Modify: `src/render/materials.js`（新增 `uHemiGround` uniform 与 `vHemi` varying，接进 `shadeLit`；`dayNight` 句柄表导出它）
- Test: `src/tests/test-hemi.js`（**新建**，Tier 1 纯函数部分）+ `src/tests/index.html`（注册）
- Test: `tests/hemisphere-ambient.spec.mjs`（**新建**，Tier 4 像素）

**Interfaces:**
- Produces: `materials.dayNight.uHemiGround`（uniform 句柄，`value: number`，默认 `0.6`）
- Produces: `src/render/hemi-shade.js` 导出 `HEMI_GROUND = 0.6` 与 `hemiFactorFor(normalIndex, ground)`（**three-free 纯函数**，供 Tier 1 与 `materials.js` 的 TSL 共用同一份公式）
- Consumes: `FACE_NORMALS`（既有导出，索引 = packed bit10-12）

- [ ] **Step 1: 写 Tier 1 失败测试**

新建 `src/tests/test-hemi.js`：

```js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { HEMI_GROUND, hemiFactorFor } from '../render/hemi-shade.js';

test('hemi-shade: 关闭档（ground=1）时六面因子恒为 1（逐位回到现状）', () => {
  for (let i = 0; i < 6; i++) {
    assertEqual(hemiFactorFor(i, 1.0), 1, `面 ${i} 关闭半球光后必须为 1`);
  }
});

test('hemi-shade: 顶面恒为 1、底面恒为 ground（与 ground 取值无关）', () => {
  for (const g of [0.2, 0.4, 0.6, 1.0]) {
    assertTrue(Math.abs(hemiFactorFor(2, g) - 1) < 1e-12, `+Y 面应恒为 1，g=${g}`);
    assertTrue(Math.abs(hemiFactorFor(3, g) - g) < 1e-12, `-Y 面应恒为 g=${g}`);
  }
});

test('hemi-shade: 四面侧面恒为 (ground+1)/2，且严格介于顶底之间', () => {
  for (const i of [0, 1, 4, 5]) {
    const v = hemiFactorFor(i, HEMI_GROUND);
    const want = (HEMI_GROUND + 1) / 2;
    assertTrue(Math.abs(v - want) < 1e-12, `面 ${i} 应为 ${want}，实测 ${v}`);
    assertTrue(v > HEMI_GROUND && v < 1, `面 ${i} 须严格介于底面与顶面之间`);
  }
});

test('hemi-shade: HEMI_GROUND 落在 (0,1) 且不是 1（1 = 关闭档）', () => {
  assertTrue(HEMI_GROUND > 0 && HEMI_GROUND < 1, `实测 ${HEMI_GROUND}`);
  assertTrue(HEMI_GROUND !== 1, '取 1 等于功能关闭，会让整项静默失效');
});
```

在 `src/tests/index.html` 的 import 区加 `import './test-hemi.js';`。

- [ ] **Step 2: 跑测试确认变红**

Run: 同 Task 1 Step 2，过滤 `'hemi-shade'`。
Expected: FAIL —— 模块不存在（浏览器控制台报 import 失败；runner 报 `0 passed` 或该 suite 缺失）

- [ ] **Step 3: 建纯函数模块**

新建 `src/render/hemi-shade.js`（**three-free**，与 `sun-shade.js` 同一手法）：

```js
// src/render/hemi-shade.js — 半球环境光的标定常数与纯函数（**three-free**）
//
// 为什么单独成模块：① Tier 1 单测（浏览器内）与 ② materials.js 的 TSL 必须落在同一份公式上
// （红线 1：两处各写一份会漂移出「单测说朝下该暗、GPU 实际没暗」，而这类撕裂没有断言之外的
// 可观测异常）。与 sun-shade.js 是平行结构。
//
// 语义：真实世界里「天空来的环境光」比「地面反射的环境光」亮得多。本仓此前所有面吃同一个
// skylight（户外恒 15），所以一个方块的顶面与底面一样亮 —— 这是「一个色块、没立体感」的来源之一。
// 本模块给 skylight 项乘一个只依赖面法线 y 的因子：朝上 1.0，朝下 HEMI_GROUND。
import { FACE_NORMALS } from './sun-shade.js';

/** 朝下面收到的环境光相对朝上面的比例。0 = 底面全黑，1 = 关闭半球光。 */
export const HEMI_GROUND = 0.6;

/**
 * 某面法线的半球环境光因子（CPU 参考实现，与 materials.js 的 TSL 同公式）。
 *
 * `factor = mix(HEMI_GROUND, 1, n.y × 0.5 + 0.5)` —— 朝上(y=+1)→1；朝下(y=−1)→ground；
 * 四个侧面(y=0)→(ground+1)/2。权重是 `n.y` 的线性函数，故六面之外不会有别的取值。
 *
 * @param {number} normalIndex 0..5，`FACE_NORMALS` 索引（= packed bit10-12）
 * @param {number} ground 朝下面的因子（`uHemiGround`；1 = 关闭）
 * @returns {number} 乘在 skylight 项上的因子
 */
export function hemiFactorFor(normalIndex, ground) {
  const ny = FACE_NORMALS[normalIndex][1];
  const w = ny * 0.5 + 0.5;
  return ground + (1 - ground) * w;
}
```

- [ ] **Step 4: 跑测试确认变绿**

Run: 同 Step 2。
Expected: 4 条 PASS

- [ ] **Step 5: 接进 TSL**

`src/render/materials.js`：

1. import 加 `import { HEMI_GROUND } from './hemi-shade.js';`
2. 在 `vSunDot` 定义之后加：

```js
// ---- 半球环境光（v1.71）----
// 真实世界里天空来的环境光比地面反射的亮得多。本仓此前所有面吃同一个 skylight（户外恒 15）
// → 一个方块的顶面与底面一样亮。这里给 skylight 项乘一个只依赖面法线 y 的因子。
// ⚠️ **只乘 skylight 项，不乘 blocklight**：火把照亮的洞穴底面不该变暗（与太阳项同一口径）。
// ⚠️ uniform 默认 = HEMI_GROUND（常量唯一权威在 hemi-shade.js，此处不写字面量）。
const uHemiGround = uniform(HEMI_GROUND);
const hemiFactor = mix(uHemiGround, float(1.0), mul(faceNormalNode.y, 0.5).add(0.5));
```

3. `shadeLit` / `shadeUnlit` 各改成：

```js
  const shadeLit = max(mul(mul(vSkyShade, hemiFactor), sunTerm), vBlockShade);
  const shadeUnlit = max(mul(vSkyShade, hemiFactor), vBlockShade);
```

4. `dayNight` 句柄表加 `uHemiGround`。

- [ ] **Step 6: 负向验证 Tier 1 接线（真游戏页）**

一次性探针起页面，读 `g.renderWorld.materials.dayNight.uHemiGround.value`：

Expected：`0.6`（不是 `undefined`，也不是 1）。若为 `undefined` 说明句柄没导出 — 这正是「静默 no-op」的形态。

- [ ] **Step 7: 写 Tier 4 像素判据**

新建 `tests/hemisphere-ambient.spec.mjs`，几何用**悬空厚板**（顶面与底面同材质、都入画）：

- 清平台上方 ±12 → 在 `y = P..P+1` 建 13×13 厚板 → 手动把光源摆到被测物上方（**必须**：阴影相机 ±48 但玩家在 y≈22，平台 P=80 在视锥外，同 `sun-shadow.spec` 的既有手法）→ 冻结玩家 → 隐藏全部 HUD。
- 两个机位：**俯视**读顶面、**仰视**读底面（`camera.up` 需避开退化，用 `[0,0,-1]`）。
- 判据（实测值见 spec §6.2，实施时重测并记入报告）：

```js
  // 主判据 ①：顶面只改 uHemiGround 时逐位不变（证明半球是纯加项，不整体压暗）
  expect(topRatio, `顶面须恒亮：${JSON.stringify({ topOff, topOn })}`).toBeGreaterThan(0.99);
  expect(topRatio).toBeLessThan(1.01);
  // 主判据 ②：底面显著变暗（实测 ground=0.2 时 −56%）
  expect(botRatio, `底面须显著变暗：${JSON.stringify({ botOff, botOn })}`).toBeLessThan(0.75);
  // sanity floor：两支读数都必须是几何（不是天空/黑屏）
  expect(topOff).toBeGreaterThan(20);
  expect(botOff).toBeGreaterThan(20);
```

（`topOff/botOff` = `uHemiGround=1.0` 的读数，`topOn/botOn` = `0.2`；比值 = on/off。）

- [ ] **Step 8: 跑 Tier 4，确认通过且负向验证真 FAIL**

Run: `npx playwright test tests/hemisphere-ambient.spec.mjs`
Expected: PASS。

随后**注入回退**：把 `HEMI_GROUND` 临时改成 `1.0`（功能关闭）→ 重跑 → 判据 ② **必须 FAIL**；
还原后重跑 → PASS。（还原用 `cp` 副本，**禁止** `git checkout` —— 工作区有未提交改动。）

- [ ] **Step 9: 提交**

```bash
git add src/render/hemi-shade.js src/render/materials.js src/tests/test-hemi.js \
        src/tests/index.html tests/hemisphere-ambient.spec.mjs
git commit -m "feat(lighting): 半球环境光 —— 天顶亮、地面暗"
```

---

### Task 5: 重标 `sun-directional.spec` 的对比度上界

**Files:**
- Modify: `tests/sun-directional.spec.mjs:137-139`（上界）、`:14-22`（sRGB 理论值域注释）

**Interfaces:**
- Consumes: Task 1 的新地板值（迎光/背光比从 1.302 加深到约 1.46）

- [ ] **Step 1: 先实测新值（不改断言）**

Run: `npx playwright test tests/sun-directional.spec.mjs`
Expected: FAIL，日志里 `SUN-DIRECTIONAL` 行的 `ratioOn` 是**实测新值**（探针期用近似组合测到 1.474）。把该数字记下来。

- [ ] **Step 2: 重算 sRGB 理论值域**

线性口径：迎光面 `SUN_AMBIENT + SUN_INTENSITY×0.6 = 0.38 + 0.775×0.6 = 0.845`，
背光面 `0.38`。线性比 `0.845/0.38 = 2.224`。过 sRGB 传递函数：
`sRGB(x) = 1.055·x^(1/2.4) − 0.055`（x > 0.0031308）。

- `sRGB(0.845) = 1.055 × 0.845^0.4167 − 0.055 ≈ 0.9313`
- `sRGB(0.380) = 1.055 × 0.380^0.4167 − 0.055 ≈ 0.6464`
- 比值 ≈ **1.441**

叠贴图基色的非线性后理论值域约 **1.41 ~ 1.50**。用 Step 1 的实测值确认落在此区间内。

- [ ] **Step 3: 按实测值重标上界（保留余量，双侧都不贴线）**

把 `:139` 的 `toBeLessThan(1.45)` 改为按实测值 + 余量的值（若实测 1.47 → 上界 **1.60**，余量 8.8%），
下界保持 `1.2` **不变**（它钉的是「真有朝向差异」，与地板值无关）。
同时更新文件头 `:14-22` 的理论值域注释（旧的 1.286~1.347 是 0.5 地板时代的数，已作废）。

- [ ] **Step 4: 跑测试确认变绿**

Run: `npx playwright test tests/sun-directional.spec.mjs`
Expected: PASS，且三条判据（关闭时等亮 / 打开时显著更亮 / 顶面不变）全绿

- [ ] **Step 5: 提交**

```bash
git add tests/sun-directional.spec.mjs
git commit -m "test(lighting): 重标方向光对比度上界（地板 0.38 口径）"
```

---

### Task 6: 重标 `sun-shadow.spec` 的影区比值

**Files:**
- Modify: `tests/sun-shadow.spec.mjs:266-310`（用例 2 的 `ratioA` 冻结值与注释）

- [ ] **Step 1: 先实测（不改断言）**

Run: `npx playwright test tests/sun-shadow.spec.mjs -g "Tier 4 有影"`
Expected: FAIL 或 PASS。读日志的 `SUN-SHADOW TIER4` 行，记下 `ratioA`（探针期用近似组合测到 0.695；正式组合须重测）。

- [ ] **Step 2: 重标，且保持双侧**

新值应为 `SUN_AMBIENT / 1.0`（影区/受光）≈ 0.38 经 sRGB 与贴图基色后的结果。
按实测值设定：上界 = 实测 + 余量（取 `0.80`，若实测约 0.60 则余量足够），
下界 = 实测 × 0.65 左右（**不得删掉下界**：v1.45 的教训 —— 只钉上界抓不到「影区纯黑」，
负向验证实测 `SHADOW_FLOOR=0` 时 `ratioA=0.122` 会被单侧断言放行）。

- [ ] **Step 3: 更新该用例的注释块**

写明：0.735 是 0.5 地板时代的冻结值，v1.71 地板改 0.38 后**有意加深**；
新值须与 spec §4.2 一致；并保留「双侧断言的理由」原文。

- [ ] **Step 4: 跑测试确认变绿**

Run: `npx playwright test tests/sun-shadow.spec.mjs -g "Tier 4 有影"`
Expected: PASS，`ratioB`（开阔区）仍 ≈ 1.000

- [ ] **Step 5: 提交**

```bash
git add tests/sun-shadow.spec.mjs
git commit -m "test(lighting): 重标影区比值（地板 0.38 口径，保留双侧断言）"
```

---

### Task 7: 重标 `sun-shadow.spec` 的两条敏感用例（远端闪烁 / 纹素对齐）

**Files:**
- Modify: `tests/sun-shadow.spec.mjs:823`（远端闪烁的采样距离）、`:986`（纹素对齐的步长或阈值）

- [ ] **Step 1: 先实测远端闪烁**

Run: `npx playwright test tests/sun-shadow.spec.mjs -g "远端闪烁"`
Expected: 可能 FAIL（探针期用近似组合实测 `d=60` 的 `range=8.1`）。读日志 `SUN-SHADOW FAR-FLICKER` 行，
记录各 `d` 的 `range` / `jumps`。

- [ ] **Step 2: 判定是「采样点失效」还是「守卫真失效」**

- 若**所有** `d` 的 `range` 都明显变大（>3）：说明是阴影视锥换了范围导致的采样点语义变化 →
  重算采样距离集合（阴影视锥现在是 ±48，采样点须落在视锥**外**且能看见几何的远处）。
- 若只有个别 `d` 变大：说明那个采样点已落在视锥内 → 换掉该点。
**不得**直接放宽 `range < 3` 的阈值 —— 它钉的是「几何整帧消失」这一硬缺陷（破坏态实测 53~56）。

- [ ] **Step 3: 修正采样距离并重跑**

Run: 同 Step 1。
Expected: PASS，且 `forced`（强制刷新次数）> 0（证明真的走了刷新路径）

- [ ] **Step 4: 实测纹素对齐**

Run: `npx playwright test tests/sun-shadow.spec.mjs -g "纹素对齐"`
Expected: 读 `SUN-SHADOW TEXEL-SNAP` 行的 `shadowSpread` / `phaseSpread` / `targetTravel`。

- [ ] **Step 5: 判定纹素对齐是否仍生效**

纹素从 0.234 变 0.094 格后，用例的 `STEP = 0.05` 相当于 0.53 纹素（此前 0.21），
12 步累计 6 纹素（此前 2.6）。**若 `phaseSpread` 仍 ≈ 0** → 对齐机制在新配置下依然生效，
**阈值 0.05 不动**（探针期的 0.75 是 ±48/1024 下未同步刷新导致的读数，须以本步实测为准）。
**若 `phaseSpread` 显著非 0** → 停下来报告：这意味着 `texelSnapOffset` 的纹素基准没有随配置更新
（真实缺陷），不得靠改阈值掩盖。

- [ ] **Step 6: 提交（仅当 Step 3 改动了采样距离）**

```bash
git add tests/sun-shadow.spec.mjs
git commit -m "test(lighting): 按新阴影覆盖重算远端闪烁采样距离"
```

---

### Task 8: 全量验证 + 文档回填

**Files:**
- Modify: `docs/phase-1-engine-design.md`（版本号 + 修订说明）
- Modify: `docs/roadmap.md`（改动表 + 活跃约束）
- Create: `docs/lighting-realism-acceptance-report.md`

- [ ] **Step 1: 跑日常门**

Run: `npm run check`
Expected: exit 0（arch/data/lint 全绿）

- [ ] **Step 2: 跑全量 E2E**

Run: `npm test`
Expected: 全绿。**特别确认** `crosshair.spec`（ACES 压亮部会让背景变暗 → 准心更易保持白色）、
`fog-color.spec`（雾色过 ACES 后相对效果应保持）、`daynight-visual.spec`（三风格亮度差）。
若有 FAIL：先判定是「本次有意改变」还是回归，前者按 Task 5/6 的口径重标并记录实测，
后者修代码。**不得为通过而放宽阈值。**

- [ ] **Step 3: 跑性能门**

Run: `npm run bench -- --check`
Expected: exit 0。若阻断，按 AGENTS.md 做**交替对照**（同会话 `git stash` 交错各 2~3 轮取中位），
比两侧分布而非单次数值。⚠️ 不带 `--check` 跑 bench 会自动重写 `docs/m3-baseline.*` ——
那是冻结基线，诊断后必须 `git checkout` 恢复。

- [ ] **Step 4: 写验收报告**

`docs/lighting-realism-acceptance-report.md`，至少含：
- 四项改动的**实施后实测值**（对比 spec 的预期值，逐项列）
- 四条新判据的实测读数
- 五条重标断言的「旧值 → 新值 → 余量」
- 负向验证清单（每项：注入什么、期望 FAIL 什么、实际 FAIL 什么）
- 性能实测（阴影刷新帧 vs 稳态帧、bench 四场景）
- 偏离 mc-lite 的清单（ACES 的 v1.58 否决被推翻、noon exposure 1.0 而非 1.25、shadow.radius 未按比例升）

- [ ] **Step 5: 回填设计文档**

`docs/phase-1-engine-design.md`：版本号 v1.69 → **v1.70**（若期间已被占用则顺延），
在文件头修订说明区加一段 `v1.70 修订说明`，内容包含：四项改动的架构口径、
**「v1.58 的 ACES 否决已被 v1.70 推翻」**、`SUN_AMBIENT ≡ SHADOW_FLOOR = 0.38` 的新标定依据、
半球环境光的「只乘 skylight」语义。

- [ ] **Step 6: 回填 roadmap**

`docs/roadmap.md`：① 「M9 之后的独立改动」表加一行 v1.70；② 「活跃约束详情」加一段
「光影真实感（v1.70）」—— 至少包含：ACES 与 unlit 管线的配套关系、地板值改动会连带改影区比值
（重标口径）、半球光不得接太阳项、`shadow.radius` 是纹素单位（改分辨率必须重新评估半影）。

- [ ] **Step 7: 提交**

```bash
git add docs/
git commit -m "docs: v1.70 光影真实感验收报告与架构口径回填"
```

---

## 自检记录

**Spec 覆盖**：spec §3（A）→ Task 2；§4（B）→ Task 1；§5（C）→ Task 3；§6（D）→ Task 4；
§8.1（五条重标）→ Task 3（配置断言）/ Task 5（对比度）/ Task 6（影区比值）/ Task 7（两条敏感用例）；
§8.2（四条新判据）→ Task 1（sun-shade 三条）/ Task 2（daynight 两条）/ Task 4（Tier 1 四条 + Tier 4）/ Task 5（扩展方向光）；§8.3（性能门）→ Task 8 Step 3；§9（风险）→ Task 3 / 7 / 8 的验证步骤；§10（八步落地）→ Task 1~8 一一对应。

**已知缺口（有意）**：spec §8.2 提到的「Tier 4 tone-mapping.spec」未单列为一个 Task ——
它的两条判据（削顶率、对比跨度）已由 Task 2 Step 5 的负向验证覆盖。若实施时发现该探针不足以
成为长期回归门，应在 Task 8 之前补一个正式 spec（记录在验收报告的「后续」段）。
