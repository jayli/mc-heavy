# 光影微调 Tab 实施计划（v3.51）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置面板中间插入第三个 Tab「光影微调」，15 个滑块实时调当前生效风格的光影参数，并可一键复制成 `参数名，变量名:值` 文本。

**Architecture:** 参数表（three-free 纯数据 + 纯函数）是唯一权威，DOM/初值/复位/复制文本全从它派生。override 存在 `DayNight` 的 `Map<风格键, overrides>` 里，由既有唯一写入收口点 `_apply` 消费 —— 面板不直接写 uniform（日夜循环每帧会覆写）。punch 两参数从常量改成运行时 uniform，烘焙脚本继续吃常量，不重烘天空。

**Tech Stack:** 原生 ES module + three r185.1 TSL（WebGPU）+ Playwright；无构建步骤。

**Spec:** `docs/superpowers/specs/2026-11-27-light-tuning-tab-design.md`

## Global Constraints

- 所有解释、注释、文案用中文（项目 AGENTS.md）。
- **不持久化**：滑块值只在本次会话有效，不写 localStorage。
- **不改任何风格缺省值**：打开面板不动滑块时画面逐位不变。
- **不改 `VISUAL_STYLES` 权威数据**（`test-daynight.js:193-196` 冻结四档 sunDirection 字面值）。
- **不重烘任何产物**、不动 `docs/m3-baseline.*`。
- Tab 顺序：`游戏设置` | `光影微调` | `关于游戏`（用户裁定放中间）。
- 面板 `.mc-content` 尺寸 `770×560` 不动；页内可视高 **448px**；前两页不得出现纵向滚动条。
- `shadowFloor` 上界 **0.9**（`materials.js:238` 拿 `1 − uShadowFloor` 当分母，取 1 会除零）。
- `waterTint` 三通道必须相等（既有全局断言：只调亮度不改色相）。
- 数值格式统一 `toFixed(3)`。
- 依赖方向：`ui` 不得 import `voxel`/`gen`；面板经 `Game` 的薄封装调 `dayNight`。
- 资源路径只走 `resourceUrl()`（本轮无新资源）。
- 提交用 Conventional Commits；**每个 Task 的 commit 步骤是本计划明确授权的提交**。

## Review Focus

1. **拖动滑块后切风格再切回来** —— 用户期望回到自己调过的值（同一风格的 override 要留着），而不是被清空或串到别的档。
2. **`shadowFloor` 拖到上界** —— 用户期望画面变亮而不是整屏 NaN/黑屏（分母 `1 − floor` 不得为 0）。
3. **非法/越界输入**（localStorage 脏值不适用，但 URL 与程序化调用可达）—— `setTuning(key, NaN/Infinity/字符串/未知key)` 不得把 uniform 写成 NaN。
4. **自动循环下拖动滑块** —— 用户期望值稳住不被每帧插值抹掉；点「恢复默认」后日夜要继续走。
5. **剪贴板不可用**（无头 / 非安全上下文 / 权限拒绝）—— 用户期望看到明确失败提示，而不是静默「点了没反应」。

---

### Task 1: 参数表与纯函数（three-free）

**Files:**
- Create: `src/render/light-tuning-config.js`
- Create: `src/tests/test-light-tuning.js`
- Modify: `src/tests/index.html`（注册新单测）
- Modify: `tools/test-tiers.mjs`（`UNIT_NODE_SAFE` 加一项）

**Interfaces:**
- Consumes: `shade-params.js` 的 `SHADOW_FLOOR` / `SUN_INTENSITY` / `HEMI_GROUND`；`ashlar-tonemap-config.js` 的 `ASHLAR_PUNCH_GAMMA` / `ASHLAR_PUNCH_SAT`。
- Produces:
  - `LIGHT_TUNING_PARAMS`: `ReadonlyArray<{key: string, label: string, varName: string, min: number, max: number, step: number, col: 'left'|'right', hint: string, agxOnly?: boolean}>`，15 项，顺序 = 左列 8 项后右列 7 项。
  - `readTuningValues(params: object): Record<string, number>` —— 从 `DayNight.get params` 形状读 15 个当前值，缺字段回落全局常量。
  - `applyTuningOverride(params: object, overrides: Record<string, number>): object` —— 返回**新对象**（数组字段也拷贝），不改入参。
  - `clampTuningValue(key: string, v: unknown): number|null` —— 未知 key 或非有限值返回 `null`。
  - `formatTuningText(values: Record<string, number>, styleKey: string|null): string` —— 首行 `风格，visualStyle: <key|auto>`，随后每行 `label，varName: v.toFixed(3)`。
  - `LIGHT_TUNING_KEYS`: `string[]`（由表派生，供测试与面板遍历）。

- [ ] **Step 1: 写失败测试**

创建 `src/tests/test-light-tuning.js`，用 `import { test } from './runner.js'` + `assertEqual/assertTrue`（照 `test-normal-style.js` 的既有形状）。用例：

1. `参数表恰 15 项、key 唯一、左右列 8/7` —— `LIGHT_TUNING_PARAMS.length === 15`；`new Set(keys).size === 15`；`filter(col==='left').length === 8`、right 7。
2. `每项 min < max 且 step > 0，缺省值落在区间内` —— 对 `VISUAL_STYLES` 全部五档 + `paramsAtHour(12)` 调 `readTuningValues`，逐 key 断言 `min <= v <= max`。
3. `shadowFloor 上界必须是 0.9（分母 1−floor 不得为 0）` —— `assertTrue(item.max <= 0.9)` 且 `assertTrue(1 - item.max > 0)`。
4. `readTuningValues 缺字段回落全局常量` —— 传 `VISUAL_STYLES.noon`（不写三个 per-style 字段），断言 `shadowFloor === SHADOW_FLOOR`、`sunIntensity === SUN_INTENSITY`、`hemiGround === HEMI_GROUND`。
5. `readTuningValues 读 normal 档实测值` —— `shadowFloor === 0.14`、`hemiGround === 0.12`、`sunIntensity === 0.956`、`toneMappingExposure === 2.2`、`punchGamma === ASHLAR_PUNCH_GAMMA`。
6. `applyTuningOverride 不改入参且数组字段是新副本` —— 对 `VISUAL_STYLES.normal` 施加 `{shadowFloor: 0.3, 'sunColor[0]': 1.5}`，断言原对象 `shadowFloor` 仍 0.14、原 `sunColor[0]` 仍 1.214，且返回对象的 `sunColor !== 原.sunColor`。
7. `applyTuningOverride 空 overrides 逐位返回等值` —— `readTuningValues(apply(p, {}))` 与 `readTuningValues(p)` 逐 key 相等。
8. `waterTint 一个键写三个分量且三通道相等` —— 施加 `{'waterTint': 0.42}` 后 `p.waterTint` 三通道全等 0.42。
9. `clampTuningValue 拒绝非法输入` —— `NaN` / `Infinity` / `'0.5'` / `undefined` / 未知 key `'nope'` 全部返回 `null`；越界值钳到 min/max（`shadowFloor` 传 5 → 0.9，传 −1 → 0）。
10. `formatTuningText 每行格式与行数` —— 行数 = 16（首行风格 + 15 项）；首行 `风格，visualStyle: normal`；含 `强光，sunIntensity: 0.956`；`styleKey=null` 时首行 `风格，visualStyle: auto`；每行都匹配 `/^.+，[A-Za-z][\w[\]]*: -?\d+\.\d{3}$/`。
11. `agxOnly 标记只落在 punch 两项` —— `filter(agxOnly).map(key)` 恰为 `['punchGamma','punchSat']`。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-light-tuning.js`
Expected: 硬失败「--only 里这些文件不在 Node 白名单内」（先把文件加进 `UNIT_NODE_SAFE` 与 `index.html` 再跑，则期望 `Cannot find module ... light-tuning-config.js`）。两种都是「实现不存在」的 RED。

- [ ] **Step 3: 实现 `src/render/light-tuning-config.js`**

按 Spec §5 的表逐项写 15 个定义（key/label/varName/min/max/step/col/hint）。key 用 varName 同名（`sunColor[0]` 这类带下标的直接用字符串键）。

`readTuningValues` 从 params 读：`sunIntensity ?? SUN_INTENSITY`、`shadowFloor ?? SHADOW_FLOOR`、`hemiGround ?? HEMI_GROUND`、`sunColor[i]`、`ambientColor[i]`、`toneMappingExposure`、`skyDim`、`blockBoost`、`waterTint[0]`、punch 两项取常量（**它们不在 params 里**，运行时值由 Task 3 的 uniform 提供，本函数只给缺省）。

`applyTuningOverride` 先浅拷贝 params 并拷贝 `sunColor`/`ambientColor`/`waterTint` 三个数组，再按键写入；`waterTint` 写三个分量。**只认表里的 key**，未知键忽略。

`formatTuningText` 用表顺序拼接，`\n` 连接，末尾不带换行。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-light-tuning.js`
Expected: 全部用例 PASS，退出码 0。

- [ ] **Step 5: 静态门**

Run: `npm run check`
Expected: arch + data + lint 全绿（新单测已归档 + 已注册，`[测试分档]` 不报错）。

- [ ] **Step 6: Commit**

```bash
git add src/render/light-tuning-config.js src/tests/test-light-tuning.js src/tests/index.html tools/test-tiers.mjs
git commit -m "feat: 光影微调参数表与纯函数（15 项，three-free 单一权威）"
```

---

### Task 2: DayNight 的 per-style override

**Files:**
- Modify: `src/render/daynight.js`（`DayNight` 类：加 `_tuning` / `_tuningFrozen`、三个公开成员、`get params` 与 `update` 消费）
- Modify: `src/tests/test-light-tuning.js`（追加 DayNight 集成用例）

**Interfaces:**
- Consumes: Task 1 的 `readTuningValues` / `applyTuningOverride` / `clampTuningValue` / `LIGHT_TUNING_KEYS`。
- Produces（`DayNight` 实例成员）：
  - `setTuning(key: string, value: unknown): number|null` —— 钳制后写入当前风格的 override 并立即 `_apply`；非法返回 `null` 且不写。当前无 override 风格（自动循环）时键用 `'auto'`，并把 `_tuningFrozen` 置 true。
  - `resetTuning(): void` —— 清当前风格 override、`_tuningFrozen = false`，重新 `_apply`。
  - `get tuningValues(): Record<string, number>` —— `readTuningValues(this.params)`。
  - `get tuningStyleKey(): string|null` —— `this._styleOverride`。

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-light-tuning.js` 追加（stub 照 `test-normal-style.js` 的 `makeStub`，需补 `uSunColor`/`uAmbientColor`/`uSunDirection`/`uWaterTint` 句柄，形状 `{value:{set(){}}}`）：

12. `setTuning 写 override 并立即生效` —— `visualStyle:'normal'` 构造后 `setTuning('shadowFloor', 0.3)` 返回 0.3，`voxelUniforms.uShadowFloor.value === 0.3`。
13. `setTuning 非法值不写` —— `setTuning('shadowFloor', NaN)` 返回 `null`，uniform 仍是上一次的值；`setTuning('nope', 1)` 返回 `null`。
14. `切风格互不污染，切回来还记得` —— normal 下 `setTuning('shadowFloor',0.3)`；`setStyle('noon')` 后 `uShadowFloor.value === SHADOW_FLOOR`；`setStyle('normal')` 后回到 0.3。
15. `resetTuning 回到风格表缺省` —— 承上，`resetTuning()` 后 `uShadowFloor.value === 0.14`。
16. `override 不改 VISUAL_STYLES 权威` —— 全程结束后 `VISUAL_STYLES.normal.shadowFloor === 0.14`、`sunColor[0] === 1.214`。
17. `自动循环下 setTuning 冻结日夜推进` —— 不带 visualStyle 构造，`setTuning('skyDim',0.5)` 后连续 `update(10)` 三次，`hour` 逐位不变且 `uSkyDim.value === 0.5`；`resetTuning()` 后 `update(10)` 让 `hour` 前进。
18. `get params 带 override 且数组是新副本` —— normal 下 `setTuning('sunColor[0]',1.5)`，`d.params.sunColor[0] === 1.5` 且 `d.params.sunColor !== VISUAL_STYLES.normal.sunColor`。
19. `不动任何滑块时 params 与改前逐位一致` —— 新构造 normal 实例，`readTuningValues(d.params)` 与 `readTuningValues(VISUAL_STYLES.normal)` 逐 key 相等。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-light-tuning.js`
Expected: 新增用例 FAIL，报 `d.setTuning is not a function`。

- [ ] **Step 3: 实现**

`DayNight` 构造加 `this._tuning = new Map()`、`this._tuningFrozen = false`。

抽一个私有 `_paramsFor(styleKey)`：取 `VISUAL_STYLES[styleKey]` 浅拷贝 + 三个数组拷贝 + 方向归一化（复用现有 `get params` 的逻辑，**不写第二份**），再 `applyTuningOverride(p, this._tuning.get(styleKey) ?? {})`。

`get params`：override 风格走 `_paramsFor(this._styleOverride)`；自动循环走 `paramsAtHour(this.hour)` 后同样套 `_tuning.get('auto')`。

`update(dt)`：`if (this._styleOverride || this._tuningFrozen) return;`（其余不变）。

`setTuning`：`clampTuningValue` → `null` 直接返回；否则写 Map（键 = `this._styleOverride ?? 'auto'`），自动档置 `_tuningFrozen = true`，然后 `this._apply(this.params)`。

`resetTuning`：`this._tuning.delete(当前键)`、`_tuningFrozen = false`、`this._apply(this.params)`。

⚠️ `_apply` 内部读 `p.sunDirection` 等，`this.params` 已归一化 —— 与既有 `setStyle` 传原值两条路径都经 `_apply` 里的 `normalizeDirection` 统一，重复归一化对已归一化向量是幂等的（长度 1）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-light-tuning.js,test-daynight.js,test-normal-style.js,test-sun-shade.js,test-cloud-shade.js,test-wet-surface.js`
Expected: 全 PASS（邻居文件覆盖全部 `daynight` 消费方，含冻结的 sunDirection 断言）。

- [ ] **Step 5: Commit**

```bash
git add src/render/daynight.js src/tests/test-light-tuning.js
git commit -m "feat: DayNight 支持 per-style 光影 override（自动档冻结日夜推进）"
```

---

### Task 3: punch 两参数改运行时 uniform

**Files:**
- Modify: `src/render/ashlar-tonemap.js`（顶层建两个 uniform，曲线读它们；导出 `ASHLAR_PUNCH_UNIFORMS`）
- Modify: `src/render/daynight.js`（`_apply` 末尾写这两个 uniform）
- Modify: `src/tests/test-light-tuning.js`（追加 punch 用例）

**Interfaces:**
- Consumes: Task 1 的 `punchGamma` / `punchSat` 键；Task 2 的 override 机制。
- Produces: `ASHLAR_PUNCH_UNIFORMS = { uPunchGamma, uPunchSat }`（从 `ashlar-tonemap.js` 导出，初值 = `ASHLAR_PUNCH_GAMMA` / `ASHLAR_PUNCH_SAT`）。`DayNight` 经可选构造项 `punchUniforms` 消费（句柄缺失时跳过，与 `uSunColor` 同一容错口径）。

- [ ] **Step 1: 写失败测试**

追加（**不 import `ashlar-tonemap.js`**，它 import three；只测 `DayNight` 侧写入，用 stub 句柄）：

20. `_apply 把 punch 两值写给句柄` —— stub 传 `punchUniforms:{uPunchGamma:{value:0},uPunchSat:{value:0}}`，normal 构造后两值分别 = `ASHLAR_PUNCH_GAMMA` / `ASHLAR_PUNCH_SAT`。
21. `setTuning('punchGamma') 真的改句柄` —— `setTuning('punchGamma',1.6)` 后 `uPunchGamma.value === 1.6`。
22. `句柄缺失不抛错` —— 不传 `punchUniforms` 构造 + `setTuning('punchSat',1.3)` 不抛。
23. `切回其余四档 punch 回落常量` —— normal 下改 punchGamma 后 `setStyle('noon')`，`uPunchGamma.value === ASHLAR_PUNCH_GAMMA`。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-light-tuning.js`
Expected: 用例 20 FAIL（`uPunchGamma.value` 仍是 0，`_apply` 没写它）。

- [ ] **Step 3: 实现**

`ashlar-tonemap.js`：顶层 `const uPunchGamma = uniform(ASHLAR_PUNCH_GAMMA)` / `uPunchSat` 同理，`export const ASHLAR_PUNCH_UNIFORMS = { uPunchGamma, uPunchSat }`；曲线里 `vec3(ASHLAR_PUNCH_GAMMA)` → `vec3(uPunchGamma)`、`float(ASHLAR_PUNCH_SAT)` → `uPunchSat`。**常量本身与 config 文件一字不动**（烘焙脚本继续吃它）。

`daynight.js`：构造参数加 `punchUniforms = null`；`_apply` 末尾按 `typeof p.punchGamma === 'number'` 写，缺省回落 import 的两个常量（从 `ashlar-tonemap-config.js` import，**不写字面量**）。

`readTuningValues`（Task 1）已给 punch 缺省 = 常量；`applyTuningOverride` 已能写这两个键 ⇒ `p.punchGamma` 在有 override 时存在。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-light-tuning.js,test-normal-style.js`
Expected: 全 PASS。

- [ ] **Step 5: 装配层接线**

`src/core/game.js`：`new DayNight({...})` 加 `punchUniforms: ASHLAR_PUNCH_UNIFORMS`（从 `../render/ashlar-tonemap.js` import，与既有 `ensureAshlarToneMapping` 同一 import 语句）。

Run: `npm run check`
Expected: 全绿（`ashlar-tonemap.js` 在 render 层，允许 import three）。

- [ ] **Step 6: Commit**

```bash
git add src/render/ashlar-tonemap.js src/render/daynight.js src/core/game.js src/tests/test-light-tuning.js
git commit -m "feat: AgX punch 两参数改运行时 uniform（烘焙常量不动）"
```

---

### Task 4: Game 薄封装 + 面板第三个 Tab

**Files:**
- Modify: `src/core/game.js`（三个公开成员）
- Modify: `src/ui/settings-panel.js`（`TAB_TUNING_LABEL`、`mkTab` 顺序、`_panelLightTuning()`、`setTab` 三态、CSS）
- Modify: `src/tests/test-ui.js`（label 常量断言）

**Interfaces:**
- Consumes: Task 1 的表与 `formatTuningText`；Task 2/3 的 `DayNight` 成员。
- Produces（`Game`）：
  - `setLightTuning(key: string, value: unknown): number|null`
  - `resetLightTuning(): void`
  - `get lightTuningValues(): Record<string, number>`
  - `get lightTuningStyleKey(): string|null`
  - `copyLightTuningText(): Promise<boolean>` —— 组文本 + 写剪贴板（失败回落 textarea），返回是否成功。
- Produces（面板 DOM id，spec 与单测都靠它）：`settings-tab-tuning`、`settings-panel-tuning`、每行滑块 `lt-<key>`（下标键的 `[`/`]` 换成 `-`，如 `lt-sunColor-0`）、读数 `lt-val-<同>`、按钮 `lt-copy` / `lt-reset`。

- [ ] **Step 1: 写失败测试**

`src/tests/test-ui.js` 追加：`assertEqual(TAB_TUNING_LABEL, '光影微调')`（import 该常量 —— 此时还不存在，故 RED）。

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/unit-fast.spec.mjs`（`test-ui.js` 需 DOM，不在 Node 白名单）
Expected: FAIL —— `TAB_TUNING_LABEL` 未导出（SyntaxError / undefined）。

- [ ] **Step 3: 实现 Game 侧**

四个薄封装直接转发 `this.dayNight`。`copyLightTuningText`：`formatTuningText(this.lightTuningValues, this.lightTuningStyleKey)` → `navigator.clipboard.writeText`，catch 后回落 `document.createElement('textarea')` + `select()` + `document.execCommand('copy')` + 移除节点；两条都失败返回 false。

- [ ] **Step 4: 实现面板侧**

- 导出 `TAB_TUNING_LABEL = '光影微调'`；`mkTab('tuning', ...)` 插在 `settings` 与 `about` **之间**。
- `setTab(key)` 改成遍历三个面板 id 切 `active`（不写三段 if）；`_tabButtons` 已是按 key 索引，天然支持。
- `_panelLightTuning()`：`.mc-tab-panel.mc-tuning`，内含 `.mc-columns` 两列，每列按表 `col` 过滤后逐项 `_makeSliderRow(def)`；底部 `.mc-tuning-footer` 放「复制参数」「恢复默认」两按钮 + 一行 `.mc-hint` 说明（自动循环下调整会暂停日夜推进 / punch 仅普通档生效）。
- `_makeSliderRow(def)`：`.mc-tuning-row` = `.mc-title`(label) + `input[type=range]` + `.mc-tuning-val`(读数)。`input` 事件 → `this.game.setLightTuning(def.key, Number(input.value))`，返回 `null` 则把滑块回写原值；返回数值则写读数并把滑块回写成真实生效值（钳制同步，照 `water-reflect-dock.js` 的口径）。
- `agxOnly` 项在当前风格 `toneMapping !== ASHLAR_TONE_MAPPING` 时 `disabled` + `.mc-tuning-off`；`setTab('tuning')` 与每次风格切换后调 `_syncTuning()` 重读全部值与 disabled 态。
- 「恢复默认」→ `game.resetLightTuning()` + `_syncTuning()`；「复制参数」→ `await game.copyLightTuningText()`，成功 toast「已复制 15 项参数」，失败 toast「复制失败，请手动选取」。
- CSS：`.mc-tuning-row` 三段 grid（标题 / 滑块 / 读数），行高紧凑到 8 行放进 448px；滑块轨道沿用面板灰底语言（`#8b8b8b` 轨道 + `#559944` thumb）。

- [ ] **Step 5: 跑测试确认 GREEN**

Run: `npx playwright test tests/unit-fast.spec.mjs`
Expected: PASS（含新 label 断言）。

- [ ] **Step 6: 静态门**

Run: `npm run check`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/core/game.js src/ui/settings-panel.js src/tests/test-ui.js
git commit -m "feat: 设置面板新增「光影微调」Tab（15 滑块 + 复制参数）"
```

---

### Task 5: 浏览器端接线验收 + 页签断言同步

**Files:**
- Create: `tests/light-tuning.spec.mjs`
- Modify: `tests/about-tab.spec.mjs:73-74`（两条页签断言改三项）
- Modify: `tools/test-tiers.mjs`（新 spec 归 `ui` 档）

**Interfaces:**
- Consumes: Task 4 的 DOM id 与 `Game` 成员；`window.__MC_GAME__`。
- Produces: 无（验收 spec）。

- [ ] **Step 1: 写失败测试**

创建 `tests/light-tuning.spec.mjs`（照 `about-tab.spec.mjs` 的 boot/openPanel/READY 口径，`?vd=2&seed=12345&style=normal`）。用例：

1. **三个页签、顺序与等宽** —— `['游戏设置','光影微调','关于游戏']`；三个 id；三者 box 宽高逐位相等、高 40px；切三个 Tab 时 `.mc-content` box 与确定按钮 box 逐位不变。
2. **15 个滑块都在，两列 8/7，无滚动条** —— `input[type=range]` 计数 15；左右列行数 8/7；`#settings-panel-tuning` 的 `scrollHeight <= clientHeight + 1`；每行读数文本非空且匹配 `/\d+\.\d{3}/`。
3. **初值 = 当前风格值（零回归锚点）** —— 15 个滑块 value 与 `game.lightTuningValues` 逐项相等；`uShadowFloor.value === 0.14`。
4. **拖滑块真改 uniform**（Review Focus 2 一并覆盖）—— 用 `input.value = '0.3'` + `dispatchEvent(new Event('input'))` 改 `lt-shadowFloor`，断言 `uShadowFloor.value === 0.3` 且读数文本变 `0.300`；再拖到 max `0.9`，断言 uniform = 0.9 且 `1 - 0.9 > 0`（分母安全）。
5. **切风格互不污染、切回来还记得**（Review Focus 1）—— normal 改 shadowFloor=0.3 → 点「正午」→ uniform = 0.38 → 点「普通」→ uniform = 0.3。
6. **非法输入不写 NaN**（Review Focus 3）—— `game.setLightTuning('shadowFloor', NaN)` 返回 null 且 uniform 不变；`setLightTuning('nope', 1)` 返回 null。
7. **自动循环下拖动冻结、恢复默认解冻**（Review Focus 4）—— `?style=` 不带（自动），记下 `dayNight.hour`，拖 skyDim 滑块，等 500ms 后 hour 逐位不变；点「恢复默认」，等 500ms 后 hour 前进。
8. **复制文本内容**（Review Focus 5）—— 注入 `navigator.clipboard.writeText` 记录器（`page.addInitScript`，**必须在 goto 之前**），点「复制参数」，断言收到 16 行、首行 `风格，visualStyle: normal`、含 `强光，sunIntensity: 0.956`；再让 writeText 抛错且 `execCommand` 返回 false，断言 toast 出现失败文案（不静默）。
9. **punch 两项只在普通档可调** —— normal 下两滑块 `disabled === false`；切正午后 `disabled === true`。
10. **恢复默认回到风格缺省** —— 改若干项后点「恢复默认」，15 项滑块值与 `readTuningValues(VISUAL_STYLES.normal)` 逐项相等。

同时改 `tests/about-tab.spec.mjs`：两条 `toEqual` 期望值改三项 / 三个 id（其余断言一字不动）。

- [ ] **Step 2: 跑测试确认 RED**

本 Task 的 RED 证据来自 `about-tab.spec` 的既有冻结断言：Task 4 已把第三个 Tab 上屏，而该 spec 还钉着「恰两个页签」⇒ 它必须真的红。这一步证明「第三个 Tab 确实进了 DOM」，而不是新 spec 自说自话。

Run: `npx playwright test tests/about-tab.spec.mjs`
Expected: FAIL —— `toEqual(['游戏设置','关于游戏'])` 实际收到三项。

⚠️ 新 spec 的用例 4/5/7 在 Task 4 正确实现后应当直接 GREEN —— 它们的 RED 由 Step 5 的负向验证补足（注入缺陷必须真 FAIL），这是本仓 pitfalls 要求的「负向验证是必需环节」。

- [ ] **Step 3: 改 about-tab 断言 + 归档新 spec**

`tools/test-tiers.mjs` 的 `UI` 数组加 `'light-tuning'`。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx playwright test tests/light-tuning.spec.mjs tests/about-tab.spec.mjs tests/normal-style.spec.mjs tests/settings-resolution.spec.mjs tests/teleport.spec.mjs`
Expected: 全 PASS（含「普通」档零回归与两处面板高度冻结断言）。

- [ ] **Step 5: 负向验证（注入 → 真 FAIL → cp 还原）**

对 `applyTuningOverride` 注入「直接返回原 params」，跑用例 4，必须真 FAIL；用 `edit` 注入、`cp` 副本还原（**不用 git checkout**）。还原后重跑确认 GREEN。

- [ ] **Step 6: Commit**

```bash
git add tests/light-tuning.spec.mjs tests/about-tab.spec.mjs tools/test-tiers.mjs
git commit -m "test: 光影微调 Tab 浏览器端接线验收 + 页签断言同步三项"
```

---

### Task 6: 文档与最终验证

**Files:**
- Modify: `docs/roadmap.md`（v3.51 行）
- Modify: `docs/pitfalls.md`（若本轮实测踩到新坑则记；无则不动）

- [ ] **Step 1: 写 roadmap 行**

v3.51：设置面板第三个 Tab「光影微调」（15 滑块 / 当前风格作用域 / 会话态 / 复制参数），punch 改运行时 uniform，附实测证据（spec 数、面板高度读数）。

- [ ] **Step 2: 最小充分集全套跑一遍**

Run: `npm run check`
Run: `npm run test:unit`
Run: `npx playwright test tests/light-tuning.spec.mjs tests/about-tab.spec.mjs tests/normal-style.spec.mjs tests/settings-resolution.spec.mjs tests/teleport.spec.mjs tests/unit-fast.spec.mjs`
Expected: 全绿。**不跑 `npm test`**（非用户要求 / 非里程碑 / 未改全局基础设施）。

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs: roadmap 记 v3.51 光影微调 Tab"
```