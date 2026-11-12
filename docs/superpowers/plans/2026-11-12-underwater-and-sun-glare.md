# 水下视觉与大气逆光 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 相机潜入水面时整体替换雾色与雾距（并压暗天空盒），同时给雾色加一层朝太阳方向的暖化，全部零新增 pass / 零新增纹理。

**Architecture:** 新增 three-free 的 `underwater-config.js` 承载常量与 `isUnderwater()` 判据；`uUnderwaterMix` / `uGlareStrength` / `underwaterColor` 三个 uniform 在 `materials.js` **模块顶层**创建并导出（与既有 `uSkyDim` / `uBlockBoost` / `uShadowStrength` / `uSunColor` 完全同口径），`setupFog` 消费它们，`sky.js` 直接 import 同一个实例压暗背景；`DayNight._apply` 是唯一写入收口点（`setUnderwater(on)` 只存标志位，与 `shadowEnabled` 同口径）。

**Tech Stack:** three.js r185.1 WebGPU（TSL，本地 `vendor/three/`）、Playwright（`channel: 'chromium'`）、浏览器内单测（`src/tests/index.html`）。

**Spec:** `docs/superpowers/specs/2026-11-12-underwater-and-sun-glare-design.md`

## Global Constraints

- **语言**：代码注释、报告用中文。
- **不新增 render pass、不新增 RT、不新增纹理采样、不新增 varying**（spec §1「明确不做」）。眩光**不得**采样 shadow map。
- **单一权威**：`WATER_FOG_COLOR` 与 `EYE_HEIGHT` 各只允许一处字面量（在 `underwater-config.js`）。
- **零回归**：`uUnderwaterMix = 0` 且 `uGlareStrength = 0` 时，所有输出逐位回到 v2.94。
- **唯一写入收口点**：`DayNight._apply`。绕开它直接写 uniform 的实现算错。
- **水下判据**必须用 `pos.y + EYE_HEIGHT`，不得用 `pos.y`，也不得用 `physics.inWater` 单独判。
- **不改** `src/voxel/constants.js` 的 `SEA_Y`、`renderer.toneMapping`、任何既有 `VISUAL_STYLES` 数值。
- 每个 Task 结束必须 `npm run check` 通过。

## 实测校准记录（2026-11-12，影子树真跑）

本计划已在 `git archive HEAD` 的干净副本（独立端口 8097）里把 Task 1~7 **全部机械落地并真跑**。
以下结论是实测的，不是估计：

| 项 | 实测结果 |
|---|---|
| Task 1 的 9 条单测 | 8 绿 1 红 → 红的那条是**用例期望值写错**（已修，见 Task 1 Step 1 注释） |
| Task 2 依赖方向 | `check:arch` **全绿**（`player/` 不参与方向检查，`check-architecture.mjs:206`） |
| Task 3/4/5 的 TSL 节点 | 浏览器侧真实构造**全部成功**（`VarNode`）；Node 侧无法验（`three` 走 import map） |
| `npm run check` | 全绿（arch + data + lint，0 error） |
| `fog-color.spec.mjs` | 7/7 绿 |
| `skybox.spec.mjs` | 2/2 绿 |
| 全量浏览器单测 | 2079 例，修掉那条用例后 0 失败 |

**实测发现并已修掉的 5 个阻断级缺陷**（初稿全部存在）：

1. **`_styleOverride` 下 `_apply` 不跑** → 固定风格（含 `?style=noon`）潜水永不生效。
   实测 `style=null→1` / `style=noon→0`。修法：双时机调 `_writeUnderwaterUniforms()`（Task 6）。
2. **DR-7 的「叠在 `uFogColorMix` 之后」在数学上不产生门控**。实测 `mix(100,30,1)=30`，
   与第一层无关。且与 §9.2 互斥 → 用户裁定改为**独立开关**（Task 3/7/8）。
3. **水下 mix 写在 `if (sky)` 内** → `?skybox=0` 时整段跳过，而 uniform 值仍为 1（计数类判据全对）。
   修法：移出块外（Task 3 Step 3）。
4. **抖动用例的期望值与实现矛盾**：`+0.05 < LAG=0.15` 仍在滞后区内，返回 true 是实现对。
   修法：偏移取 `2×LAG`（Task 1）。
5. **spec §5.3 写「运行时初值都是生效值」** 与实际 `uniform(0.0)` 矛盾 → 已改正表述。

## Review Focus

以下五类问题 spec 有暗示但没有任务的断言能完整覆盖，实现时最可能在这里出错（每条都挂在了对应 Task 的步骤里）：

1. **玩家站在浅水里**（水到脚脖、`physics.inWater = true` 但眼睛在水面之上）→ 画面不得整片变蓝。判据在 Task 2。
2. **关掉「雾色」开关后潜水** → 水下**仍压色**（用户 2026-11-12 裁定：水下独立于雾色开关）。真正的关闭判据是 `?underwater=0`，在 Task 8 用例 3。
3. **`?skybox=0` 启动后潜水** → 雾必须仍然变蓝。要求水下两条 `mix` 写在 `if (sky)` **之外**（spec DR-8）；写在块内则整段跳过，而 `uUnderwaterMix` 仍为 1（计数类判据全对）。判据在 Task 8 用例 4。
4. **`setupSky` 加载失败** → 启动不得抛错，雾的水下 uniform 仍是有效值。判据在 Task 6。
5. **贴水面反复潜浮**（`pos.y` 在水面 ±0.05 抖动）→ 不得每帧翻转。判据在 Task 2 与 Task 8。

---

### Task 1: `underwater-config.js` 常量模块与 `isUnderwater()` 纯函数

**Files:**
- Create: `src/render/underwater-config.js`
- Create: `src/tests/test-underwater-config.js`
- Modify: `src/tests/index.html`（在 `import './test-fog-sky-direction.js';` 之后插入一行）

**Interfaces:**
- Consumes: `SEA_Y` from `src/voxel/constants.js`（已存在，值 `-2`）
- Produces:
  - `EYE_HEIGHT: number` = `1.62`
  - `EYE_SUBMERGE_LAG: number` = `0.15`
  - `WATER_FOG_COLOR: number` = `0x6b9cc0`
  - `WATER_UNDERWATER_TINT: readonly number[]`（`[r,g,b]`，均值 ≈ 1）
  - `UNDERWATER_FOG_NEAR: number`、`UNDERWATER_FOG_FAR: number`
  - `GLARE_VISFACTOR: number` = `0.075`
  - `GLARE_STRENGTH: number` = `0.08`
  - `WATER_SURFACE_Y: number` = `SEA_Y + 0.5`
  - `isUnderwater(inWater: boolean, feetY: number): boolean`

- [ ] **Step 1: 写失败测试**

创建 `src/tests/test-underwater-config.js`：

```js
// 水下判据（Tier 1）：眼睛高度口径 + 浮出水面余量
//
// 判据的唯一权威 = `src/render/underwater-config.js`，materials.js / sky.js 消费它的常数。
//
// ⚠️ 本文件钉住三条**载荷性**口径（spec DR-2）：
//   ① 用 `feetY + EYE_HEIGHT`（眼睛高度），不是 `feetY`；
//   ② 保留 `inWater` 门控 —— 只按高度判会让浅水陆地面整片变蓝；
//   ③ `EYE_SUBMERGE_LAG` 是**水面之上**的余量（正值 = 提前入水）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  EYE_HEIGHT, EYE_SUBMERGE_LAG, WATER_SURFACE_Y, WATER_UNDERWATER_TINT, WATER_FOG_COLOR,
  UNDERWATER_FOG_NEAR, UNDERWATER_FOG_FAR, GLARE_VISFACTOR, GLARE_STRENGTH,
  isUnderwater,
} from '../render/underwater-config.js';
import { SEA_Y } from '../voxel/constants.js';

test('underwater: WATER_SURFACE_Y 由 SEA_Y 派生（与 ocean.js 的水面平面同源）', () => {
  assertEqual(WATER_SURFACE_Y, SEA_Y + 0.5, '水面高度必须等于海平面 +0.5');
  assertEqual(WATER_SURFACE_Y, -1.5, 'SEA_Y=-2 → 水面 -1.5；改动 SEA_Y 会连带改变这里');
});

test('underwater: inWater=false 时恒返回 false（浅水陆地面不得变蓝）', () => {
  assertFalse(isUnderwater(false, WATER_SURFACE_Y - 10), 'inWater 是物理权限，不得绕过');
  assertFalse(isUnderwater(false, 0), '干燥高空必须为 false');
});

test('underwater: 眼睛在水面之上时返回 false（用眼睛高度而非脚底）', () => {
  const feet = WATER_SURFACE_Y - 1; // 眼睛 = 水面之上 0.62 - lag
  assertFalse(isUnderwater(true, feet), `眼睛高度 ${feet + EYE_HEIGHT} 应仍在水面上`);
});

test('underwater: 眼睛潜到水面以下时返回 true', () => {
  const feet = WATER_SURFACE_Y - 3;
  assertTrue(isUnderwater(true, feet), '深潜必须为 true');
});

test('underwater: EYE_SUBMERGE_LAG 是水面之上的余量（正值提前入水）', () => {
  assertTrue(EYE_SUBMERGE_LAG > 0, '滞后量必须为正，否则贴水面会先闪一下出水再入水');
  const feet = WATER_SURFACE_Y - EYE_HEIGHT;
  assertTrue(isUnderwater(true, feet), '眼睛恰在水面时应已进入水下（lag 的正号语义）');
  const feetAbove = WATER_SURFACE_Y + 2 * EYE_SUBMERGE_LAG - EYE_HEIGHT;
  assertFalse(isUnderwater(true, feetAbove), '眼睛高过 lag 两倍必须已出水');
});

test('underwater: 贴水面抖动不产生翻转（同一侧输入稳定）', () => {
  const base = WATER_SURFACE_Y - EYE_HEIGHT;
  const a = isUnderwater(true, base - 0.05);
  const b = isUnderwater(true, base);
  assertTrue(a && b, `水面及略下方都必须为 true，实测 ${a}/${b}`);
  // ⚠️ 偏移必须 **> EYE_SUBMERGE_LAG**，不能用 0.05：LAG=0.15 的语义是
  // 「水面之上 0.15 以内仍算水下」，取 +0.05 落在滞后区内 ⇒ 返回 true 是**实现对**。
  // （初稿这里写 +0.05 并期望 false，实测 2079 例中唯一失败的就是它。）
  const c = isUnderwater(true, base + 2 * EYE_SUBMERGE_LAG);
  assertFalse(c, `高过滞后区必须为 false，实测 ${c}`);
});

test('underwater: 常数关系（NaN / 负值 / 顺序错误都要被抓到）', () => {
  assertTrue(Number.isFinite(EYE_HEIGHT) && EYE_HEIGHT > 0, 'EYE_HEIGHT 必须是正常数');
  assertTrue(UNDERWATER_FOG_NEAR >= 0, '近平面不得为负');
  assertTrue(UNDERWATER_FOG_FAR > UNDERWATER_FOG_NEAR, '远平面必须大于近平面');
  assertTrue(UNDERWATER_FOG_FAR <= 25, `用户裁定能见度 ≈25 格，实测 ${UNDERWATER_FOG_FAR}`);
  assertTrue(GLARE_VISFACTOR > 0 && GLARE_VISFACTOR < 1, 'visfactor 必须在 (0,1)');
  assertTrue(GLARE_STRENGTH >= 0 && GLARE_STRENGTH <= 0.25, '强度不得回退成上游的 0.25×');
});

test('underwater: WATER_UNDERWATER_TINT 是均值 ≈1 的相对乘数（不是绝对颜色）', () => {
  assertEqual(WATER_UNDERWATER_TINT.length, 3, '必须三分量');
  const mean = (WATER_UNDERWATER_TINT[0] + WATER_UNDERWATER_TINT[1] + WATER_UNDERWATER_TINT[2]) / 3;
  assertTrue(Math.abs(mean - 1) < 0.15, `均值必须 ≈1（只改色相不改曝光），实测 ${mean}`);
  assertTrue(WATER_UNDERWATER_TINT[2] > WATER_UNDERWATER_TINT[1], 'B 必须大于 G');
  assertTrue(WATER_UNDERWATER_TINT[1] > WATER_UNDERWATER_TINT[0], 'G 必须大于 R');
});

test('underwater: WATER_FOG_COLOR 是 v1.85 标定值且色相为 B>G>R', () => {
  assertEqual(WATER_FOG_COLOR, 0x6b9cc0, '常量值不得漂移（ocean.js 的远景海面全靠它）');
  const r = ((WATER_FOG_COLOR >> 16) & 255) / 255;
  const g = ((WATER_FOG_COLOR >> 8) & 255) / 255;
  const b = (WATER_FOG_COLOR & 255) / 255;
  assertTrue(b > g && g > r, `WATER_FOG_COLOR 必须 B>G>R，实测 ${r}/${g}/${b}`);
});
```

- [ ] **Step 2: 注册进 index.html**

在 `src/tests/index.html` 第 75 行 `import './test-fog-sky-direction.js';` 之后插入：

```html
    import './test-underwater-config.js';
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "0 失败"`
Expected: FAIL —— 无法解析 `../render/underwater-config.js`（文件不存在）

- [ ] **Step 4: 实现 `src/render/underwater-config.js`**

结构如下（注释按 spec 的 DR-2 / DR-4 / §8 填理由，不留占位符）：

```js
// src/render/underwater-config.js — 水下视觉与大气逆光的标定常数与纯函数（**three-free**）
import { SEA_Y } from '../voxel/constants.js';

export const WATER_SURFACE_Y = SEA_Y + 0.5;
export const EYE_HEIGHT = 1.62;
export const EYE_SUBMERGE_LAG = 0.15;
export const WATER_FOG_COLOR = 0x6b9cc0;
export const WATER_UNDERWATER_TINT = Object.freeze([0.82, 0.98, 1.18]);
export const UNDERWATER_FOG_NEAR = 0;
export const UNDERWATER_FOG_FAR = 25;
export const GLARE_VISFACTOR = 0.075;
export const GLARE_STRENGTH = 0.08;

/**
 * 相机是否处于「水下」视觉状态。纯函数、three-free、可确定性单测。
 * @param {boolean} inWater `physics.inWater`（物理权限，读的是身体中段）
 * @param {number} feetY `physics.pos.y`（**脚底**世界坐标）
 * @returns {boolean}
 */
export function isUnderwater(inWater, feetY) {
  if (!inWater) return false;
  return (feetY + EYE_HEIGHT) < (WATER_SURFACE_Y + EYE_SUBMERGE_LAG);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs -g "0 失败"`
Expected: PASS，`window.__MC_TEST_RESULTS__.failed === 0`，新增 9 条用例出现在 `suites.flatMap(s => s.tests)`

- [ ] **Step 6: 跑门禁**

Run: `npm run check`
Expected: PASS（`check:arch` 查新文件未误引 three —— 本模块只 import `voxel/constants.js`）

- [ ] **Step 7: 提交**

```bash
git add src/render/underwater-config.js src/tests/test-underwater-config.js src/tests/index.html
git commit -m "feat: 新增水下视觉常数模块与 isUnderwater 判据"
```

---

### Task 2: 把 `WATER_FOG_COLOR` 与 `EYE_HEIGHT` 收敛到唯一权威

**Files:**
- Modify: `src/render/ocean.js:86`
- Modify: `src/player/player.js:18`

**Interfaces:**
- Consumes: Task 1 的 `WATER_FOG_COLOR` / `EYE_HEIGHT`
- Produces: 行为不变（值相同），只是来源换了

- [ ] **Step 1: 改 `ocean.js`**

- 顶部 import 区追加：`import { WATER_FOG_COLOR } from './underwater-config.js';`
- 删除第 86 行 `const WATER_FOG_COLOR = 0x6b9cc0;` —— 该行上方那段 v1.82~v1.85 的历史色值表注释**保留**（它记录标定依据）。
- 第 101 行 `const uFogColor = uniform(new THREE.Color(WATER_FOG_COLOR));` 不动。

- [ ] **Step 2: 改 `player.js`**

- 顶部 import 区追加：`import { EYE_HEIGHT } from '../render/underwater-config.js';`
- 删除第 18 行 `const EYE_HEIGHT = 1.62;`。

> **依赖方向已实测确认无问题**（2026-11-12 影子树）：`check-architecture.mjs:206` 明写
> 「`player/`/`ui/`/`save/` 在分层图里指向上层，也不参与方向检查」，`LAYER_ORDER` 只含
> `voxel/gen/mesh/render`。实测 `npm run check:arch` 在本 Task 后仍全绿（162 个源文件）。
> 不需要把 `EYE_HEIGHT` 改放 `player/constants.js`。

- [ ] **Step 3: 跑单测与门禁**

Run: `npx playwright test tests/harness.spec.mjs -g "0 失败"` → PASS
Run: `npm run check` → PASS（重点看 `check:arch` 无新增违规）

- [ ] **Step 4: 视觉零回归抽查（水面）**

Run: `npx playwright test tests/water-visual.spec.mjs`
Expected: PASS —— 水面雾色值本身没改，只是来源换了

- [ ] **Step 5: 提交**

```bash
git add src/render/ocean.js src/player/player.js
git commit -m "refactor: WATER_FOG_COLOR 与 EYE_HEIGHT 收敛到 underwater-config.js"
```

---

### Task 3: 模块级 uniform + `setupFog` 的水下雾替换

**Files:**
- Modify: `src/render/materials.js`（模块顶层 uniform 区约 60-105 行；`setupFog` 约 245-291 行）

**Interfaces:**
- Consumes: Task 1 的 `WATER_FOG_COLOR` / `WATER_UNDERWATER_TINT` / `UNDERWATER_FOG_NEAR` / `UNDERWATER_FOG_FAR`
- Produces（**模块级导出**，Task 4/5/6 依赖这几个名字）：
  - `export const uUnderwaterMix`（`uniform(0.0)`）
  - `export const uGlareStrength`（`uniform(0.0)`）
  - `export const uUnderwaterColor`（`uniform(THREE.Color)`）
  - `setupFog()` 的返回**不变**（仍是 `{ fogNear, fogFar, fogColor, uFogColorMix }`）

> **为什么放模块顶层而不是 `setupFog` 内**：`sky.js` 也要消费 `uUnderwaterMix`。模块级导出与既有 `uSkyDim` / `uBlockBoost` / `uShadowStrength` / `uSunColor`（`materials.js:29-30,67,104`）**完全同口径**，既不需要改 `setupSky` 的签名，也不需要调整 `game.js` 的装配顺序。

- [ ] **Step 1: 加模块级 uniform**

在 `const uShadowStrength = uniform(1.0);`（第 67 行）之后插入：

```js
// ---- 水下视觉（v2.95，spec DR-1/DR-4）----
// 模块级单例，与 uSkyDim/uBlockBoost 同口径：`setupFog` 消费它，`sky.js` **直接 import 同一实例**
// 压暗背景棱镜图。两处各建一份会漂移出「雾已变蓝、天空还是晴天」的撕裂，而这类撕裂
// 没有断言之外的可观测异常（与 uNightBlend 在背景与雾色两处共用同一实例同一教训）。
// 初值 0 = 功能关闭 → 逐位回到 v2.94（spec §5 不变式 1）。
export const uUnderwaterMix = uniform(0.0);
/**
 * 逆光眩光强度（v2.95，spec DR-5）。**与水下独立**的开关 —— 否则两条效果无法做
 * 单变量 A/B（spec §5 不变式 3）。初值 0 = 关闭。
 */
export const uGlareStrength = uniform(0.0);
/**
 * 水下雾色 = 水面雾色 × 相对色相乘数（spec DR-4：不新增色相权威）。
 * ⚠️ `new THREE.Color(hex)` 已按 sRGB→线性处理，三通道乘 tint 在**线性域**进行；
 * 不要在手写 RGB 分量上乘（那是 sRGB 域，会得到偏亮的假色）。
 */
const _underwaterBase = new THREE.Color(WATER_FOG_COLOR);
export const uUnderwaterColor = uniform(new THREE.Color(
  _underwaterBase.r * WATER_UNDERWATER_TINT[0],
  _underwaterBase.g * WATER_UNDERWATER_TINT[1],
  _underwaterBase.b * WATER_UNDERWATER_TINT[2],
));
```

import 区追加：

```js
import {
  WATER_FOG_COLOR, WATER_UNDERWATER_TINT,
  UNDERWATER_FOG_NEAR, UNDERWATER_FOG_FAR,
} from './underwater-config.js';
```

- [ ] **Step 2: `setupFog` 里加水下雾距 uniform**

在 `const uFogColorMix = uniform(0.0);`（第 251 行）之后加：

```js
  // 水下雾距（spec DR-3：只换距离，不换雾形状）
  const underwaterNear = uniform(UNDERWATER_FOG_NEAR);
  const underwaterFar = uniform(UNDERWATER_FOG_FAR);
```

- [ ] **Step 3: 雾色加水下替换（必须在 `if (sky)` **之外**）**

⚠️ **位置载荷性（spec DR-8，实测标定）**：`let colorNode = fogColor;` 在 `if (sky)` 外，
而 `colorNode = mix(fogColor, skyColor, uFogColorMix);` 在 `if (sky)` **内**。
水下那一层必须接在 **`if (sky)` 块的右花括号之后**，否则 `?skybox=0` 时整段被跳过
→ 水下完全无效果，而 `uUnderwaterMix` 的值仍为 1（**计数类判据全对**）。

把 `if (sky) { ... }` 结束后的那一行之前插入：

```js
  // 水下雾色替换（v2.95，spec DR-1/DR-7/DR-8）。
  // ⚠️ **必须在 if (sky) 之外** —— ?skybox=0 时仍要生效（无天空盒也要能潜水）。
  // ⚠️ **不受 uFogColorMix 门控**：水下是独立开关（?underwater）。初稿想让「关雾色」
  //    连带关水下，实测证明那与「?skybox=0 仍生效」互斥（game.setFogColorEnabled 在无
  //    天空盒时强制 uFogColorMix=0），用户 2026-11-12 裁定取独立开关。
  colorNode = mix(colorNode, uUnderwaterColor, uUnderwaterMix);
```

**不要**动 `if (sky)` 内那句 `colorNode = mix(fogColor, skyColor, uFogColorMix);`。

- [ ] **Step 4: 雾距改混合**

把第 289 行 `scene.fogNode = fog(colorNode, rangeFogFactor(fogNear, fogFar));` 改为：

```js
  // 雾距：水面口径 ⇄ 水下口径（同一混合因子，spec DR-1「三条都用同一个 mix 层级」）
  scene.fogNode = fog(colorNode, rangeFogFactor(
    mix(fogNear, underwaterNear, uUnderwaterMix),
    mix(fogFar, underwaterFar, uUnderwaterMix),
  ));
```

- [ ] **Step 5: 加入 `dayNight` 句柄表**

把 `createVoxelMaterials` 返回的 `dayNight:` 那一行（第 216 行）改为：

```js
    dayNight: {
      uSkyDim, uBlockBoost, uShadowStrength, uSunDirection, uSunStrength,
      uHemiGround, uSunColor, uAmbientColor,
      // v2.95：水下与眩光（`DayNight._apply` 是唯一写入口）
      uUnderwaterMix, uGlareStrength,
    },
```

- [ ] **Step 6: 确认零回归**

Run: `npx playwright test tests/fog-color.spec.mjs`
Expected: PASS（`uUnderwaterMix` 初值 0 → `mix` 取左端，雾色/雾距逐位不变）

> **已实测**（2026-11-12 影子树，端口 8097）：本 Task + Task 4/5/6/7 全部落地后，
> `fog-color.spec.mjs` 7 条全绿、`skybox.spec.mjs` 2 条全绿，`npm run check` 全绿。

- [ ] **Step 7: 提交**

```bash
git add src/render/materials.js
git commit -m "feat: 水下雾替换的模块级 uniform 与雾距混合"
```

---

### Task 4: 眩光暖化项

**Files:**
- Modify: `src/render/materials.js`（`setupFog` 的 `if (sky)` 块内末尾）

**Interfaces:**
- Consumes: Task 3 的 `uGlareStrength`；模块级已有的 `uSunDirection`、`uSunColor`
- Produces: 无新导出

- [ ] **Step 1: 把眩光加进 `skyColor`**

在 `if (sky) { ... }` 块内，`const skyColor = mix(dayNight, duskSample.rgb, sky.uDuskBlend);` 这一行改为 `let skyColor = ...`，并在其后插入：

```js
    // ---- 逆光眩光（v2.95，spec DR-5）----
    // 语义：朝太阳方向的天边暖化（**大气透视**，不是太阳光晕）。**不挂钩遮拦** ——
    // 太阳在墙后也暖，因为大气散射与遮挡无关；正因如此它才能零采样 shadow map。
    // 公式与上游 `sunGlare.glsl` 同构：e8 = (n·L)^8，glare = vis/(1-(1-vis)·e8) - vis
    // ⚠️ 该式在 e8=0 时恰为 0，但**不得依赖这个巧合**：独立开关 uGlareStrength 才是
    //    A/B 的保证（spec §5 不变式 3）。
    const cosSun = max(dot(dir, uSunDirection), 0.0);
    const e2 = cosSun.mul(cosSun);
    const e4 = e2.mul(e2);
    const e8 = e4.mul(e4);
    const glare = float(GLARE_VISFACTOR).div(
      float(1).sub(float(1 - GLARE_VISFACTOR).mul(e8)),
    ).sub(float(GLARE_VISFACTOR));
    // 乘 cosSun 让眩光在天顶附近自然衰减；乘 uSunColor 保证与直射光色温同源（spec DR-5）
    skyColor = add(skyColor, mul(mul(glare, cosSun), mul(uSunColor, uGlareStrength)));
```

⚠️ 眩光**只在 `sky` 分支存在时生效**。`?skybox=0` 时该路径不存在 → 眩光不生效，属有意降级（spec §9 同口径），写进验收报告。

- [ ] **Step 2: 补 import**

`three/tsl` 的 import 列表补 `sub`（乘链上 `mul`/`add`/`max`/`dot`/`float` 已在）。
`./underwater-config.js` 的 import 补 `GLARE_VISFACTOR`。

> `GLARE_STRENGTH` 由 `DayNight` 消费（Task 6），本文件不需要。

- [ ] **Step 3: 确认零回归**

Run: `npx playwright test tests/fog-color.spec.mjs`
Expected: PASS（`uGlareStrength` 初值 0 → 加项恒 0）

- [ ] **Step 4: 提交**

```bash
git add src/render/materials.js
git commit -m "feat: 雾色增加朝太阳方向的眩光暖化项"
```

---

### Task 5: `sky.js` 共用 `uUnderwaterMix` 压暗背景

**Files:**
- Modify: `src/render/sky.js`（`setupSky` 内的 `backgroundNode` 构造处）

**Interfaces:**
- Consumes: Task 3 的 `uUnderwaterMix`（`import` 同一实例）
- Produces: `setupSky(scene)` 签名**不变**，返回值不变

- [ ] **Step 1: 压暗背景节点**

在 `scene.backgroundNode = mix(dayNightMix, cubeTexture(duskCube), uDuskBlend);` 之后插入：

```js
  // 水下压暗（v2.95，spec DR-6）：背景不经过 scene.fogNode，必须自己压一次，
  // 否则水下抬头仍看见晴天。
  // ⚠️ 用 materials.js **导出的同一个 uniform 实例**，不得在此自建 ——
  // 两个实例会漂移出「雾已变蓝、天空还是晴天」的撕裂。
  const UNDERWATER_SKY_TINT = vec3(0.28, 0.46, 0.62);
  scene.backgroundNode = mul(
    scene.backgroundNode,
    mix(vec3(1.0), UNDERWATER_SKY_TINT, uUnderwaterMix),
  );
```

import 区追加：

```js
import { uUnderwaterMix } from './materials.js';
```

`three/tsl` 的 import 补 `mul`、`vec3`（`mix` 已在）。

> **循环依赖检查（已核）**：`materials.js` 不 import `sky.js`（它只 import three/tsl + sun-shade + hemi-shade + fog-sky-direction + underwater-config）→ 无环。

- [ ] **Step 2: 确认启动不崩 + 天空盒路径正常**

Run: `npx playwright test tests/skybox.spec.mjs`
Expected: PASS（`uUnderwaterMix` 初值 0 → `mix(vec3(1),tint,0)` = 白 → 背景逐位不变）

- [ ] **Step 3: 确认 `?skybox=0` 路径不崩**

Run: `npx playwright test tests/fog-color.spec.mjs`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/render/sky.js
git commit -m "feat: 天空盒共用 uUnderwaterMix 并在水下压暗背景"
```

---

### Task 6: `DayNight` 接入水下标志位（唯一写入收口点）

**Files:**
- Modify: `src/render/daynight.js`（`setUnderwater` + `_apply`）
- Modify: `src/core/game.js`（帧循环推进判据）
- Test: `src/tests/test-daynight.js`（追加用例）

**Interfaces:**
- Consumes: Task 3 的 `uUnderwaterMix` / `uGlareStrength`，经**已有的** `voxelUniforms` 通道（`game.js:425` 传的就是 `renderWorld.materials.dayNight`）—— **不需要新构造参数**
- Produces:
  - `DayNight.prototype.setUnderwater(on: boolean): void` —— 只存 `this.underwater`
  - `_apply` 写入：`uUnderwaterMix.value = this.underwater ? 1 : 0`；`uGlareStrength.value = this.underwater ? 0 : GLARE_STRENGTH`

> **注意**：`uGlareStrength` 与水下**反相** —— 水里不该有天空方向的光晕（那是大气透视，水里没有那种大气）。

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-daynight.js` 追加：

```js
test('daynight: setUnderwater 经 _apply 写入 uUnderwaterMix，且眩光反相', () => {
  const voxel = {
    uSkyDim: { value: 1 }, uBlockBoost: { value: 1 },
    uShadowStrength: { value: 1 }, uSunDirection: { value: { set() {} } },
    uSunColor: { value: { set() {} } }, uAmbientColor: { value: { set() {} } },
    uUnderwaterMix: { value: 0 }, uGlareStrength: { value: 0 },
  };
  const fog = { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } };
  const dn = new DayNight({ scene: {}, fog, voxelUniforms: voxel });
  dn.setUnderwater(true);
  dn.update(0.016);
  assertEqual(voxel.uUnderwaterMix.value, 1, '水下必须置 1');
  assertEqual(voxel.uGlareStrength.value, 0, '水下必须关眩光');
  dn.setUnderwater(false);
  dn.update(0.016);
  assertEqual(voxel.uUnderwaterMix.value, 0, '出水必须回 0');
  assertTrue(voxel.uGlareStrength.value > 0, '出水必须恢复眩光');
});

// ⚠️ 这条是**阻断级缺陷的回归门**（spec §9.7）：固定风格下 update() early-return，
// _apply 不跑 ⇒ 若只在 _apply 里写 uniform，本用例必红。它也是 Tier 4 用 ?style=noon 的前提。
test('daynight: 固定风格（_styleOverride）下潜水仍生效', () => {
  const voxel = {
    uSkyDim: { value: 1 }, uBlockBoost: { value: 1 },
    uShadowStrength: { value: 1 }, uSunDirection: { value: { set() {} } },
    uSunColor: { value: { set() {} } }, uAmbientColor: { value: { set() {} } },
    uUnderwaterMix: { value: 0 }, uGlareStrength: { value: 0 },
  };
  const fog = { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } };
  const dn = new DayNight({ scene: {}, fog, voxelUniforms: voxel, visualStyle: 'noon' });
  assertTrue(!!dn._styleOverride, '前提：visualStyle 非空 ⇒ 进入 override');
  dn.setUnderwater(true);
  dn.update(0.016);   // 固定风格下这句会 early-return，不调 _apply
  assertEqual(voxel.uUnderwaterMix.value, 1, '固定风格下潜水必须仍生效（setUnderwater 自己写）');
  dn.setUnderwater(false);
  dn.update(0.016);
  assertEqual(voxel.uUnderwaterMix.value, 0, '固定风格下出水必须回 0');
});

test('daynight: 水下不改写任何既有 uniform（零回归）', () => {
  const voxel = {
    uSkyDim: { value: 1 }, uBlockBoost: { value: 1 },
    uShadowStrength: { value: 1 }, uSunDirection: { value: { set() {} } },
    uSunColor: { value: { set() {} } }, uAmbientColor: { value: { set() {} } },
    uUnderwaterMix: { value: 0 }, uGlareStrength: { value: 0 },
  };
  const fog = { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } };
  const dn = new DayNight({ scene: {}, fog, voxelUniforms: voxel });
  const before = { sky: voxel.uSkyDim.value, boost: voxel.uBlockBoost.value };
  dn.setUnderwater(true);
  dn.update(0.016);
  assertEqual(voxel.uSkyDim.value, before.sky, 'skyDim 不得被水下改动');
  assertEqual(voxel.uBlockBoost.value, before.boost, 'blockBoost 不得被水下改动');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "0 失败"`
Expected: FAIL —— `dn.setUnderwater is not a function`

- [ ] **Step 3: 实现 `daynight.js`**

⚠️⚠️ **阻断级陷阱（实测确认，spec §9.7）**：`update(dt)` 开头就是
`if (this._styleOverride) return;`（`daynight.js:412`）。面板选了任何风格（含 `?style=noon`）
后 `_styleOverride` 非空 ⇒ **`_apply` 每帧不跑** ⇒ 只写在 `_apply` 里的水下 uniform 永不更新。
实测对照：`style=null → uUnderwaterMix=1`（OK）而 `style=noon → 0`（**静默失效**）。
而 Tier 4 spec 普遍用 `?style=noon` 冻结变量 ⇒ 整套像素判据会全部量到「未生效」。

**因此必须双时机调用同一个私有公式**（不是第二份公式，红线 1）：

构造器里加（紧邻 `this.shadowEnabled = true;`）：

```js
    this.underwater = false;
    this.glareEnabled = true;
    this.underwaterDisabled = false;
```

新增两个方法（放在 `setTime` 之前）：

```js
  /**
   * 水下/眩光 uniform 的**唯一公式**（v2.95）。
   * 两个调用时机：`_apply`（日夜循环）与 `setUnderwater`（值变化）。
   * ⚠️ 为何需要第二个时机：`update()` 在 `_styleOverride` 非空时 early-return，
   * 固定风格下 `_apply` 根本不跑 —— 只靠 `_apply` 会让面板选过风格的玩家潜水无效果。
   * 公式只有一份，所以不违反「唯一收口点」（同 setStyle 与 update 都调 _apply）。
   */
  _writeUnderwaterUniforms() {
    const uUnderwaterMix = this.voxelUniforms.uUnderwaterMix;
    if (uUnderwaterMix) {
      uUnderwaterMix.value = (this.underwater && !this.underwaterDisabled) ? 1 : 0;
    }
    const uGlareStrength = this.voxelUniforms.uGlareStrength;
    if (uGlareStrength) {
      uGlareStrength.value = (this.underwater || !this.glareEnabled) ? 0 : GLARE_STRENGTH;
    }
  }

  /**
   * 水下状态（v2.95）。值**变化时**立即写一次 —— 固定风格下 `_apply` 不跑，
   * 不这么做就永不生效（见 _writeUnderwaterUniforms 注释）。
   * 每帧调用但只在翻转时写，无额外开销。
   * @param {boolean} on
   */
  setUnderwater(on) {
    const next = !!on;
    if (next === this.underwater) return;
    this.underwater = next;
    this._writeUnderwaterUniforms();
  }
```

`_apply` 末尾（`if (this.onSunDirection)` 之前）只加**一行调用**：

```js
    this._writeUnderwaterUniforms();
```

import `GLARE_STRENGTH` from `./underwater-config.js`。
⚠️ **`daynight.js` 当前没有任何 import 语句**（它是刻意的 three-free 纯模块，实测确认）——
import 要插在文件头注释之后、`export const VISUAL_STYLE_KEYS` 之前。
`underwater-config.js` 也是 three-free，不破坏该模块的性质。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs -g "0 失败"` → PASS

- [ ] **Step 5: 接到 `game.js` 帧循环**

在 `this.dayNight.update(dt);`（第 1275 行）之后加：

```js
      // 水下判据（v2.95）：眼睛高度口径，见 underwater-config.js 的 isUnderwater 注释。
      // 每帧一次纯比较，无分配。
      this.dayNight.setUnderwater(
        isUnderwater(this.player.physics.inWater, this.player.physics.pos.y),
      );
```

import `isUnderwater` from `'../render/underwater-config.js'`。

- [ ] **Step 6: 确认启动不崩**

Run: `npx playwright test tests/harness.spec.mjs -g "0 失败"` → PASS

- [ ] **Step 7: 提交**

```bash
git add src/render/daynight.js src/core/game.js src/tests/test-daynight.js
git commit -m "feat: DayNight 接入水下标志位与眩光强度写入"
```

---

### Task 7: URL 调试开关

**Files:**
- Modify: `src/ui/settings.js`（`DEFAULT_SETTINGS` + `resolveSettings`）
- Modify: `src/render/daynight.js`（`glareEnabled` 标志）
- Modify: `src/core/game.js`（`start()` 尾部消费）
- Test: Task 8 的 Tier 4 spec 用这两个开关做 A/B

**Interfaces:**
- Consumes: Task 3 的 `uUnderwaterMix` / `uGlareStrength`
- Produces: `settings.underwater: boolean`（默认 `true`）、`settings.glare: boolean`（默认 `true`）

- [ ] **Step 1: 加 URL 参数**

在 `settings.js` 的 `DEFAULT_SETTINGS` 里加：

```js
  // v2.95：水下 / 眩光的调试开关。**不进面板、不持久化**（只用于 Tier 4 的单变量 A/B），
  // 所以不需要 settingsVersion 迁移 —— 旧存档没有这两个字段，回落默认 true（与 pixelRatio 同理）。
  underwater: true,
  glare: true,
```

`resolveSettings` 里（与 `?fog=` 同一处）加：

```js
    if (params.has('underwater')) s.underwater = params.get('underwater') === '1';
    if (params.has('glare')) s.glare = params.get('glare') === '1';
```

- [ ] **Step 2: `DayNight` 加 `glareEnabled`**

`_apply` 里 `uGlareStrength` 那一行改为：

```js
    if (uGlareStrength) {
      uGlareStrength.value = (this.underwater || !this.glareEnabled) ? 0 : GLARE_STRENGTH;
    }
```

并在构造器里加 `this.glareEnabled = true;`（紧邻 `this.underwater = false;`）。

> ⚠️ 必须走 `_apply`：`uGlareStrength` 每帧被 `_apply` 覆写，直接在 `game.js` 里写一次 0 会在下一帧被冲掉（与 v1.61 `shadowEnabled` 那次的静默失效同形态）。

- [ ] **Step 3: `game.js` 消费**

`start()` 尾部（`this.setFogColorEnabled(...)` 之后）加：

```js
    // v2.95 调试开关：水下/眩光默认都开，仅关时写入。
    // ⚠️ 必须同时告知 dayNight —— uGlareStrength / uUnderwaterMix 每帧被 _apply 覆写，
    // 只写 uniform 会在下一帧被冲回（同 shadowEnabled 的静默失效形态）。
    if (!this.settings.underwater) this.dayNight.underwaterDisabled = true;
    if (!this.settings.glare) this.dayNight.glareEnabled = false;
```

并把 `_apply` 里水下那一行改为遵守 `underwaterDisabled`：

```js
    if (uUnderwaterMix) {
      uUnderwaterMix.value = (this.underwater && !this.underwaterDisabled) ? 1 : 0;
    }
```

构造器加 `this.underwaterDisabled = false;`。

- [ ] **Step 4: 跑门禁**

Run: `npm run check && npx playwright test tests/harness.spec.mjs -g "0 失败"`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/ui/settings.js src/render/daynight.js src/core/game.js
git commit -m "feat: 水下与眩光的 URL 调试开关"
```

---

### Task 8: Tier 4 像素实测标定与开关判据

**Files:**
- Create: `tests/underwater-visual.spec.mjs`

**Interfaces:**
- Consumes: Task 1-7 的全部接线；`window.__MC_GAME__` 编程驱动
- Produces: 标定数字回填 Task 1 的常量

> **本 Task 的产出是数字，不是代码。** 每个 Step 得到一组实测值。

- [ ] **Step 1: 写探针 spec**

创建 `tests/underwater-visual.spec.mjs`，照 `tests/water-visual.spec.mjs` 的启动模式（`page.goto(...)`、`waitForFunction(() => window.__MC_GAME__?.worldReady)`、`channel: 'chromium'`）。

四条用例：
1. **深潜 vs 水面之上**：用 `__MC_GAME__.player.physics.pos.y` 编程设定，各截一次；水区亮度分带（近/中/远）与 `R−B` 色相都要变，且**同时钉上下界**（只钉「变暗」抓不到「纯黑」）。
2. **浅水不触发**（Review Focus 1）：`pos.y` 设成水面下 0.5 格（眼睛仍在水上）→ 像素必须与陆地参照一致。
3. **`?underwater=0` 关闭后潜水**（Review Focus 2）：像素必须与陆地参照一致（验独立开关）。
   ⚠️ **不得**写成「`?fog=0` 时水下不压色」—— 用户 2026-11-12 裁定水下独立于雾色开关，那条钉的是错行为。
4. **`?skybox=0` 兼底下水**（Review Focus 3）：雾必须仍变蓝 —— 钉 DR-8（水下 mix 在 `if (sky)` 之外）。
   眩光在该路径下不生效是**预期**，不得断言它生效。

⚠️ **可以用 `?style=noon` 冻结变量**，但前提是 Task 6 的双时机写入已落地（spec §9.7）；
否则 `update()` early-return 会让四条用例全部量到「未生效」而看似「功能没做」。
⚠️ **编程驱动潜水要同时设 `physics.inWater = true`**：只改 `pos.y` 不够 —— 物理下一帧会用真实方块重算它。

- [ ] **Step 2: 跑标定扫描**

`UNDERWATER_FOG_FAR ∈ {18, 22, 25, 28, 32}` 各截一次，记录「远景轮廓消失但方向感在」的交点。
`GLARE_STRENGTH ∈ {0, 0.04, 0.08, 0.12}` 各截一次（朝太阳），记录「能看出暖化但不糊」的档位。

- [ ] **Step 3: 回填常量并写实测依据**

按实测值更新 `underwater-config.js` 的 `WATER_UNDERWATER_TINT` / `UNDERWATER_FOG_NEAR` / `UNDERWATER_FOG_FAR` / `GLARE_VISFACTOR` / `GLARE_STRENGTH`，每个常量上方写「实测依据 + 表」（照 `ocean.js` 的 `WATER_COLOR` 注释格式）。

- [ ] **Step 4: 跑 spec 确认全绿**

Run: `npx playwright test tests/underwater-visual.spec.mjs`
Expected: PASS

- [ ] **Step 5: 负向验证（必做，三个注入各领一次红）**

1. 把水下的两条 `mix` 挪进 `if (sky)` 块内 → 用例 4（`?skybox=0`）必须红；
2. `isUnderwater` 改成用 `feetY` 而非 `feetY + EYE_HEIGHT` → 用例 2（浅水）必须红；
3. 把 `setUnderwater` 改回「只存标志位、不自己写」 → Task 6 的「固定风格下潜水仍生效」单测必须红。

**撤销注入必须用 `cp` 副本还原，禁止 `git checkout` / `git restore`**（仓库有并发会话的未提交改动）。

- [ ] **Step 6: 帧时门禁**

Run: `npm run bench -- --check`
Expected: 退出码 0。若 `frameP95` 判红，用**交替对照**判定（vsync 量子化噪声），不要直接改阈值。

- [ ] **Step 7: 更新文档**

- `docs/roadmap.md` 版本表新增 `v2.95` 行，写实测数字；
- `CLAUDE.md`「高频坑」加一条：水下判据必须用眼睛高度（`pos.y + EYE_HEIGHT`），且 `uUnderwaterMix` 的 `mix` 必须在 `uFogColorMix` 合并**之后**。

- [ ] **Step 8: 提交**

```bash
git add tests/underwater-visual.spec.mjs src/render/underwater-config.js docs/roadmap.md CLAUDE.md
git commit -m "test: 水下视觉与眩光的 Tier 4 像素判据与标定值"
```

---

## 附：任务依赖图

```
Task 1 (常量+纯函数)
  ├─→ Task 2 (收敛字面量)
  └─→ Task 3 (模块级 uniform + 雾替换)
        ├─→ Task 4 (眩光项)      ─┐
        ├─→ Task 5 (sky 共用)     │
        └─→ Task 6 (DayNight)     │
              └─→ Task 7 (URL)   ─┘
                    └─→ Task 8 (Tier 4 标定 + 文档)
```

Task 3、4 都改 `materials.js` 的同一函数，若同一会话连续实现可合并成一次编辑再分别跑验证；但测试失败时归因会变模糊，subagent-driven 模式下保持分开。
