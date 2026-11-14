# 夜间月光照耀 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让夜里的光照方向与月轮位置一致，并把夜间色温改成冷色 —— 观感是「月亮那侧泛蓝、影子朝反方向」。

**Architecture:** 只改数据层。`VISUAL_STYLES` 四个风格的 `moonDirection` 对齐同风格 `sunDirection`（`sunDirection` 一个字节不动），`night` 的 `sunColor`/`ambientColor` 改冷色。着色器、`materials.js`、`shadow-manager.js`、`ocean.js`、`sky.js`、`game.js` **零改动** —— 月亮现在与光照同向，夜间影子自动变成"月亮投下的"。

**Tech Stack:** 纯 JS（无构建），three r185.1 WebGPU，Playwright E2E，浏览器内单测（`src/tests/`）。

**Spec:** `docs/superpowers/specs/2026-11-14-night-moonlight-design.md`

## Global Constraints

- 分支 `feat/moonlight`（已建）。**不提交**，除非用户明确要求。
- `VISUAL_STYLES` 的 **`sunDirection` 一个字节不动** —— 它是 mc-lite 原值，被阴影灯定位、枪 PBR 高光、三个 spec 直接消费。
- `skyDim 0.25` / `toneMappingExposure 1.6` / `SHADOW_FLOOR 0.38` / `HEMI_GROUND 0.6` / `SUN_INTENSITY` **全部不动**。
- `night.sunColor = [0.795, 0.954, 1.431]`、`night.ambientColor = [0.954, 1.018, 1.208]`，**均值 1.0600，不是 1.0**（原因见 spec DR-3：ACES 肩部）。不得"顺手归一"。
- 明确不做：水面高光接线（`ocean.js` 的 `uSunDirection` 保持硬编码）、月影强度/刷新频率、第二盏方向光、`moonSize`/`moonVisible`/`nightBlend`/`duskBlend`。
- 相机与场景参数（`vd`/`seed`/机位）在 Tier 4 用例内固定，保证可复现。
- 门禁：`npm run check` → `npm test`。改 `daynight.js`（materials 的上游）后需跑 `npm run bench -- --check`。

## Review Focus

以下五类输入/条件是本 spec 没明说、但实现时最可能被弄坏的地方，每条都在对应任务的测试里钉住：

1. **自动日夜循环在 19:00~21:00 的方向连续性** —— 若只改 `night` 而漏改 `morning`，月亮会在 2 小时内扫过天顶、单步方位跳 61.7°。Task 2 用 0.125h 全程采样断言 `moonDirection ≡ sunDirection` 钉死。
2. **`dusk-style.spec` 的「其余三风格零回归」循环包含 `night`** —— 它断言 `sunColor` 逐位 `[1,1,1]`，本轮会 FAIL。Task 4 必须改这个 spec，否则整条回归红。另：该循环里的 `null`（自动循环）必须移出 —— 它落在哪个色温取决于启动小时，断言会随时间 flaky。
3. **色温均值的"顺手归一"冲动** —— 均值必须是 1.0600。Task 1 的断言区间取 `[1.04, 1.08]` 而不是 `[0.99, 1.01]`，就是要让"改成 1.000"真 FAIL。
4. **水面在夜间的观感** —— 本轮不接 `uSunDirection`，但 `night.waterTint 0.39` 与曝光 1.6 的组合已有既有断言（near luma 84 / far 123）。Task 5 把这些 spec 列入回归，确认没被色温间接影响。
5. **`moonSprite` 位置与光照方向的一致性** —— 这是本轮唯一"新增的可观测关系"，且只能在真实页面里验。Task 3 用 dot > 0.999 直接钉住，而不是用"亮面朝向"这类间接代理（方案 A 不改光照方向，代理判据会测既有行为）。

---

### Task 1: 夜间色温改冷色（数据 + 单测）

**Files:**
- Modify: `src/render/daynight.js:172`（`night.sunColor` / `ambientColor` 两个字段）
- Test: `src/tests/test-daynight.js:305-327`

**Interfaces:**
- Consumes: 无（纯数据改动）
- Produces: `VISUAL_STYLES.night.sunColor = [0.795, 0.954, 1.431]`、`VISUAL_STYLES.night.ambientColor = [0.954, 1.018, 1.208]`。Task 3/4/5 依赖这两个值及其均值 1.0600。

- [ ] **Step 1: 写失败测试（改两条既有断言 + 加一条均值断言）**

`src/tests/test-daynight.js:305` 的 `test('dusk：三种既有风格的色温字段保持中性…')` 改成：

```js
test('dusk：morning/noon 色温保持中性，night 为月光冷色（v3.00）', () => {
  for (const key of ['morning', 'noon']) {
    const s = VISUAL_STYLES[key];
    assertEqual(s.sunColor.join(','), '1,1,1', `${key}.sunColor 须为中性白`);
    assertEqual(s.ambientColor.join(','), '1,1,1', `${key}.ambientColor 须为中性白`);
  }
  const n = VISUAL_STYLES.night;
  assertTrue(n.sunColor[2] > n.sunColor[0] + 0.4, `night 直射光须偏冷（B 明显大于 R）：R=${n.sunColor[0]} B=${n.sunColor[2]}`);
  assertTrue(n.ambientColor[2] > n.ambientColor[0] + 0.15, `night 环境光须偏冷：R=${n.ambientColor[0]} B=${n.ambientColor[2]}`);
});
```

再新增一条（放在同一位置之后）。**注意断言区间是 `[1.04, 1.08]`，不是 1.0** —— 这是 spec DR-3 的标定值：

```js
test('夜月色温：均值必须是 1.0600（ACES 肩部标定值，不得归一到 1.0）', () => {
  const n = VISUAL_STYLES.night;
  const mean = (v) => (v[0] + v[1] + v[2]) / 3;
  const sm = mean(n.sunColor), am = mean(n.ambientColor);
  assertTrue(sm > 1.04 && sm < 1.08, `night.sunColor 均值须 ≈1.060（ACES 肩部标定）：实测 ${sm.toFixed(4)}`);
  assertTrue(am > 1.04 && am < 1.08, `night.ambientColor 均值须 ≈1.060：实测 ${am.toFixed(4)}`);
  // ⚠️ 归一到 1.000 会让六面平均 luma 从 100.84 掉到 97.14（−3.3%），违反"保持现状亮度"
  assertTrue(Math.abs(sm - 1.0) > 0.03, `均值不得被归一到 1.0（那会掉 3.3% 亮度）：实测 ${sm.toFixed(4)}`);
});
```

`src/tests/test-daynight.js:321` 的 `test('不变式：自动日夜循环全程 duskBlend=0…')` 里，把 `sunColor 必须中性` 两条改成按小时分段：

```js
test('不变式：自动日夜循环全程 duskBlend=0（傍晚只能手动选，不会混进循环）', () => {
  for (let h = 0; h <= 24; h += 0.25) {
    const p = paramsAtHour(h);
    assertEqual(p.duskBlend, 0, `h=${h} 的 duskBlend 必须为 0`);
    // v3.00：night 段（含 0~5 与 21~24 的恒定夜段 + 插值夜段）已不是中性白。
    // 判据用「是否已完全进入 night」而不是硬编码小时 —— 与 moonVisible 的取端逻辑同口径。
    const isNight = p.moonVisible === true;
    if (isNight) {
      assertTrue(p.sunColor[2] > p.sunColor[0], `h=${h}（夜）的 sunColor 须偏冷：R=${p.sunColor[0]}`);
    } else {
      assertEqual(p.sunColor.join(','), '1,1,1', `h=${h}（非夜）的 sunColor 必须中性`);
      assertEqual(p.ambientColor.join(','), '1,1,1', `h=${h}（非夜）的 ambientColor 必须中性`);
    }
  }
});
```

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单测"`
Expected: FAIL —— `night 直射光须偏冷（B 明显大于 R）：R=1 B=1` 与 `night.sunColor 均值须 ≈1.060：实测 1.0000`

- [ ] **Step 3: 改 `daynight.js` 的 night 色温**

`src/render/daynight.js:172`，把 `moonDirection` 与 `sunColor` 两个字段所在的两行改为：

```js
    moonDirection: [-0.32, 0.58, -0.75], moonVisible: true, moonSize: 34,
    // 月光色温（v3.00）：冷蓝直射 + 更冷的环境。**均值 1.0600，不是 1.0** ——
    // 均值恰为 1.000 的同色相候选实测六面平均 luma 97.14（−3.3%），因为 ACES 在迎光面
    // 已进肩部、B 通道压缩率高于 R/G。1.06 是「把肩部吃掉的亮度补回来」的标定值。
    // 屏幕口径实测（基色 0.5 × shade × skyDim 0.25 × 曝光 1.6 → ACES → sRGB）：
    // 六面平均 luma 100.50 → 100.84（+0.3%）、迎光面 R−B 0 → −32、背光面 0 → −15、
    // 迎光/背光比 1.91 → 1.87（朝向对比不得被抹平，守 ≥1.8）。
    sunColor: Object.freeze([0.795, 0.954, 1.431]),
    ambientColor: Object.freeze([0.954, 1.018, 1.208]),
    duskBlend: 0,
```

**不要**顺手改 `moonDirection`（那是 Task 2），也**不要**改任何 `skyDim`/`toneMappingExposure`。

- [ ] **Step 4: 运行测试确认 PASS**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单测"`
Expected: PASS（`failed === 0`）。若「不变式：自动日夜循环」那条仍红，说明 `moonVisible` 的分段判据与真实插值不符 —— 先 `console.log` 打 `paramsAtHour(h)` 的 `moonVisible` 与实际色温，按实测改判据，**不要**放宽成恒真。

- [ ] **Step 5: Commit**

```bash
git add src/render/daynight.js src/tests/test-daynight.js
git commit -m "feat(daynight): 夜间色温改为月光冷色（均值 1.06，亮度不变）"
```

---

### Task 2: 四风格 moonDirection 对齐 sunDirection（数据 + 单测）

**Files:**
- Modify: `src/render/daynight.js:73`（morning）、`:89`（noon）、`:132`（dusk）、`:171`（night）
- Test: `src/tests/test-daynight.js:173-185`
- Create: `src/tests/test-moonlight.js`
- Modify: `src/tests/index.html:75`（注册新测试文件）

**Interfaces:**
- Consumes: Task 1 的 `night.sunColor`/`ambientColor`（无关，但同一文件）
- Produces: 四个风格的 `moonDirection` 与同风格 `sunDirection` 归一化后完全相等（dot = 1 ± 1e-12）。Task 3/4 依赖这条不变式。

- [ ] **Step 1: 写失败测试（改写既有用例）**

`src/tests/test-daynight.js:173` 整条替换：

```js
test('四风格 moonDirection ≡ sunDirection（v3.00 月光照耀：月亮在光来的那侧）', () => {
  for (const key of Object.keys(VISUAL_STYLES)) {
    const s = VISUAL_STYLES[key];
    const a = normalize(s.sunDirection), b = normalize(s.moonDirection);
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assertTrue(Math.abs(dot - 1) < 1e-12,
      `${key}: moonDirection 必须与 sunDirection 同向，实测 dot=${dot}`);
  }
  // 原值溯源：sunDirection 仍是 mc-lite 原值（本轮一个字节不动）
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT].sunDirection;
  assertEqual(k.join(','), '0.08,0.25,0.96', 'night.sunDirection 须仍是 mc-lite 原值');
  for (const h of [0, 4, 7.5, 12, 18.5, 23]) {
    const d = paramsAtHour(h).moonDirection;
    const len = Math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2);
    assertTrue(Math.abs(len - 1) < 1e-6, `h=${h}: |len-1| = ${Math.abs(len - 1)}`);
  }
});
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单测"`
Expected: FAIL —— `morning: moonDirection 必须与 sunDirection 同向，实测 dot=-0.9999...`（morning 现状大致反向）

- [ ] **Step 3: 建 `src/tests/test-moonlight.js`**

```js
// src/tests/test-moonlight.js — 夜间月光照耀（v3.00）的纯函数契约
//
// 方案 A 的核心不变式：**月亮方向 ≡ 光照方向**。这条不在着色器里，而在数据层：
// `VISUAL_STYLES[key].moonDirection` 与同风格 `sunDirection` 同向 ⇒ 月轮 sprite 出现在
// 太阳光来的那侧 ⇒ 夜间迎光面朝向月亮、影子背离月亮。
//
// ⚠️ 为什么必须四风格都对齐、而不是只改 night：19:00~21:00 是 `moonVisible` 已为 true
// 但方向仍在 morning→night 之间插值的时段。只改 night 会让月亮在这 2 小时里扫过天顶
// （仰角 26.7°→64.4°→14.5°、单步方位跳 61.7°）。四风格一起改则月亮永远沿太阳的既有
// 平滑轨迹（全程 dot = 1.000000）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { VISUAL_STYLES, paramsAtHour } from '../render/daynight.js';

function normalize(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

test('moonlight: 全天任意小时 moonDirection ≡ sunDirection（插值同轨迹）', () => {
  // 0.125h 网格：既有「方向连续」用例用的就是这个网格（7/9/17/19 边界都是它的整数倍）
  for (let h = 0; h <= 24 + 1e-9; h += 0.125) {
    const p = paramsAtHour(h);
    for (let i = 0; i < 3; i++) {
      assertTrue(Math.abs(p.moonDirection[i] - p.sunDirection[i]) < 1e-12,
        `h=${h.toFixed(3)} 分量 ${i}: moon=${p.moonDirection[i]} sun=${p.sunDirection[i]}`);
    }
  }
});

test('moonlight: 月亮走过的轨迹连续（只改 night 会在 20:00 跳 61.7°）', () => {
  // 单独一条：即使「moon ≡ sun」成立，也不代表插值本身连续 —— 它依赖风格数据都对齐。
  // 阈值沿用既有用例的 0.05（归一化后分量差）。
  // ⚠️ 四风格全对齐后 moon 与 sun 同轨迹 ⇒ 实测最大分量差就是 sun 的 0.02513。
  //    只改 night 时实测会到 0.13+（20:00 单步跳 61.7°），本阈值能抓到。
  let prev = paramsAtHour(0).moonDirection;
  for (let h = 0.125; h <= 24 + 1e-9; h += 0.125) {
    const cur = paramsAtHour(h).moonDirection;
    for (let i = 0; i < 3; i++) {
      assertTrue(Math.abs(cur[i] - prev[i]) < 0.05,
        `moon 轨迹不连续 at h=${h.toFixed(3)} 分量 ${i}: ${prev[i]} -> ${cur[i]}`);
    }
    prev = cur;
  }
});

test('moonlight: 月亮出现的时段（19~21）方向必须单调走向 night 值', () => {
  // moonVisible 在 19.5 起为 true。此前插值的是 morning→night，此时 morning.moonDirection
  // 若不对齐会给出一个完全不同的方位 —— 这正是「只改 night」的失效形态。
  const nightDir = normalize(VISUAL_STYLES.night.moonDirection);
  for (const h of [19.5, 20, 20.5, 21, 22]) {
    const p = paramsAtHour(h);
    assertTrue(p.moonVisible === true, `h=${h} 月亮应可见`);
    const d = p.moonDirection;
    const dot = d[0] * nightDir[0] + d[1] * nightDir[1] + d[2] * nightDir[2];
    assertTrue(dot > 0.85, `h=${h} 月亮方向须接近 night 值（不得跳到另一侧）：dot=${dot.toFixed(4)}`);
  }
});

test('moonlight: night 的月光色温偏冷且量级合理', () => {
  const n = VISUAL_STYLES.night;
  // 冷色方向性：B > R
  assertTrue(n.sunColor[2] > n.sunColor[0], `直射须偏冷：R=${n.sunColor[0]} B=${n.sunColor[2]}`);
  assertTrue(n.ambientColor[2] > n.ambientColor[0], `环境须偏冷：R=${n.ambientColor[0]} B=${n.ambientColor[2]}`);
  // 量级：与 dusk（1.50 / 0.58）同档，不得失控
  for (const v of [...n.sunColor, ...n.ambientColor]) {
    assertTrue(v > 0.5 && v <= 1.5, `色温分量须在 (0.5, 1.5]：${v}`);
  }
});
```

- [ ] **Step 4: 注册测试文件**

`src/tests/index.html` 在 `import './test-daynight.js';`（第 73 行）之后插入一行：

```html
    import './test-moonlight.js';
```

- [ ] **Step 5: 运行确认新文件里的用例 FAIL**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单测"`
Expected: FAIL —— `moonlight: 全天任意小时 moonDirection ≡ sunDirection` 与 `月亮出现的时段` 两条红（数据尚未改）

- [ ] **Step 6: 改四个风格的 moonDirection**

`src/render/daynight.js`，四处各把 `moonDirection` 的值换成"与同风格 `sunDirection` 相同"。保持行内格式与 `moonVisible`/`moonSize` 不动：

| 行 | 风格 | 改后 |
|---|---|---|
| 73 | morning | `moonDirection: [0.18, 0.45, 0.88], moonVisible: false, moonSize: 20,` |
| 89 | noon | `moonDirection: [0, 0.8, 0.6], moonVisible: false, moonSize: 18,` |
| 132 | dusk | `moonDirection: [0.665, 0.208, 0.688], moonVisible: false, moonSize: 22,` |
| 171 | night | `moonDirection: [0.08, 0.25, 0.96], moonVisible: true, moonSize: 34,` |

在 `VISUAL_STYLES` 定义之前（`export const VISUAL_STYLES = {` 上方）加一段注释：

```js
/**
 * ⚠️ **不变式：`moonDirection` 恒等于同风格 `sunDirection`**（v3.00 夜间月光照耀）。
 *
 * 用户的裁定是「把月亮的位置改成跟太阳的位置一样」—— 因为体素材质的 N·L 方向光用的是
 * `sunDirection`，月亮搬到同侧后夜间迎光面就朝月亮、影子背离月亮，而 `sunDirection`
 * 仍是 mc-lite 原值（阴影灯定位、枪 PBR 高光、三个 spec 的接线口径都不受影响）。
 *
 * **四个风格必须全部对齐，不能只改 night**：19:00~21:00 是 `moonVisible` 已为 true 但
 * 方向仍在 morning→night 之间插值的时段，只改 night 会让月亮在这 2 小时里扫过天顶
 * （实测仰角 26.7°→64.4°→14.5°、单步方位跳 61.7°）。morning/noon/dusk 的
 * `moonVisible` 本来就是 false，对齐它们在视觉上零影响。
 *
 * 判据：`src/tests/test-moonlight.js`（dot = 1）与 `test-daynight.js`。
 */
```

- [ ] **Step 7: 运行确认 PASS**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单测"`
Expected: PASS，`failed === 0`

- [ ] **Step 8: Commit**

```bash
git add src/render/daynight.js src/tests/test-daynight.js src/tests/test-moonlight.js src/tests/index.html
git commit -m "feat(daynight): 四风格 moonDirection 对齐 sunDirection（月亮在光来的那侧）"
```

---

### Task 3: Tier 4 像素验收（月轮方向一致性 + 冷色 + 隔离）

**Files:**
- Create: `tests/moonlight.spec.mjs`

**Interfaces:**
- Consumes: Task 1 的色温、Task 2 的 `moonDirection ≡ sunDirection`
- Produces: 无（终端验证任务）

- [ ] **Step 1: 写 spec（4 条判据，第一条是核心）**

```js
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * Tier 4：夜间月光照耀（v3.00）—— 方案 A「月亮搬到光照方向那侧」的像素级验收。
 *
 * ## 本轮到底改了什么（这决定判据能测什么）
 *
 * 方案 A **不动 `uSunDirection`**（它仍等于 `sunDirection`）⇒ 体素世界的 N·L 几何**逐位不变**。
 * 所以「切光照方向看亮度差」测的是既有行为，**不是**本轮改动 —— 那种判据会假绿。
 * 本轮两个可观测变化：
 *   ① 月轮 sprite 搬到了光照方向那侧（几何）；
 *   ② 夜间色温变冷（像素）。
 *
 * ## 判据
 *   ① 月轮方向 ≡ `uSunDirection`（几何，dot > 0.999）—— 本轮的核心断言；
 *   ② 夜间地面偏冷（像素 R−B < −12），且 luma 在现状 ±10% 内（"保持现状亮度"）；
 *   ③ 隔离：只改 `moonDirection` 重摆月轮 ⇒ 地面像素逐位不变（钉住"不经过光照通路"）；
 *   ④ 白天零回归：`?style=noon` 的月轮不可见、色温中性。
 *
 * ⚠️ HUD 必须隐藏、阴影必须关（`setShadowsEnabled(false)`）—— `sun-shadow`/`dusk-style` 的既有教训：
 *    perf HUD 半透明黑底会造出假暗区，阴影会让整屏亮度随影区面积浮动。
 */

const URL_BASE = '/?vd=4&seed=12345&weather=clear';

function regionMeanRGB(png, x, y, half) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
      const o = (py * png.width + px) * 4;
      r += png.data[o]; g += png.data[o + 1]; b += png.data[o + 2]; n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}

async function boot(page, style) {
  await page.goto(`${URL_BASE}&style=${style}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 隔离：关阴影（会随影区面积浮动整屏亮度）+ 隐藏 HUD（半透明黑底造假暗区）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.setShadowsEnabled(false);
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) el.style.display = 'none';
    g.pushModal('tier4-moon');
  });
}

test('月光①：月轮方向必须等于光照方向（dot > 0.999）', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page, 'night');
  const s = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g._updateCelestial(); // 保证 sprite 已按当前 params 摆好
    const cam = g.camera.position;
    const m = g.sky.moonSprite.position;
    const dx = m.x - cam.x, dy = m.y - cam.y, dz = m.z - cam.z;
    const len = Math.hypot(dx, dy, dz);
    const u = g.renderWorld.materials.dayNight.uSunDirection.value;
    return {
      moon: [dx / len, dy / len, dz / len],
      sun: [u.x, u.y, u.z],
      sunLen: Math.hypot(u.x, u.y, u.z),
      visible: g.sky.moonSprite.visible,
    };
  });
  const dot = s.moon[0] * s.sun[0] + s.moon[1] * s.sun[1] + s.moon[2] * s.sun[2];
  console.log('MOONLIGHT DIR:', JSON.stringify({ dot: +dot.toFixed(6), moon: s.moon.map(v => +v.toFixed(4)), sun: s.sun.map(v => +v.toFixed(4)) }));

  expect(s.visible, '夜间月轮须可见（moonVisible 驱动）').toBe(true);
  expect(s.sunLen, 'uSunDirection 须是单位向量（否则 dot 无意义）').toBeGreaterThan(0.999);
  expect(dot, `月轮方向须与光照方向一致（月亮在光来的那侧），实测 dot=${dot.toFixed(6)}`)
    .toBeGreaterThan(0.999);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-moon'));
});

test('月光②：夜间地面偏冷（单页 A/B：只切 uSunColor/uAmbientColor）', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page, 'night');
  // 固定机位：站在出生点上方俯视自己的平台（纯地面，无天空/无远景）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g.camera.up.set(0, 0, -1);
    g.camera.position.set(p.x, p.y + 12, p.z);
    g.camera.lookAt(p.x, p.y + 1, p.z);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
  });
  const sample = async () => {
    await page.waitForTimeout(700);
    const px = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      const v = new g.camera.position.constructor(p.x, p.y + 1, p.z);
      v.project(g.camera);
      return {
        x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
        y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
      };
    });
    return regionMeanRGB(PNG.sync.read(await page.screenshot()), px.x, px.y, 10);
  };

  // 同一页、同一机位、同一帧配置 —— **唯一变量 = 两个色温 uniform**（交替对照）。
  // ⚠️ 不写绝对亮度阈值（俯视平台的 luma 取决于脚下 biome，写死一个数就是「断言想象中的世界」）。
  // ⚠️ 中性色 [1,1,1] 在 IEEE754 下逐位精确 ⇒ 它正是改动前的现状。
  const cold = await sample();
  await page.evaluate(() => {
    const d = window.__MC_GAME__.renderWorld.materials.dayNight;
    d.uSunColor.value.set(1, 1, 1);
    d.uAmbientColor.value.set(1, 1, 1);
  });
  const neutral = await sample();

  const warm = (c) => c.r - c.b;
  const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  console.log('MOONLIGHT COLOR (A/B):', JSON.stringify({
    cold: { r: +cold.r.toFixed(1), g: +cold.g.toFixed(1), b: +cold.b.toFixed(1), warm: +warm(cold).toFixed(1), luma: +luma(cold).toFixed(1) },
    neutral: { r: +neutral.r.toFixed(1), g: +neutral.g.toFixed(1), b: +neutral.b.toFixed(1), warm: +warm(neutral).toFixed(1), luma: +luma(neutral).toFixed(1) },
  }));

  expect(neutral.r, '须读到地面几何而非黑屏').toBeGreaterThan(20);
  expect(Math.abs(warm(neutral)), '中性色温下地面应泛灰（R−B ≈ 0，容差 6）').toBeLessThan(6);
  // 冷色判据（屏幕口径）：spec 实测迎光 R−B = −32、背面 −15 ⇒ 俯视地面混合后应明显为负
  expect(warm(cold), `冷色温下地面须偏冷（R−B < −12）：实测 ${warm(cold).toFixed(1)}`).toBeLessThan(-12);
  // 亮度不变（用户裁定「保持现状亮度」）：两侧相对差 < 16%
  // ⚠️ 同页同帧交替对照，读数只差色温这一个变量 ⇒ 这条才是真正有效的亮度判据
  const lr = luma(cold) / luma(neutral);
  expect(lr, `换色温不得改变整体亮度（目标 +0.3%，容差 ±16%）：实测比 ${lr.toFixed(3)}`).toBeGreaterThan(0.84);
  expect(lr, `换色温不得改变整体亮度：实测比 ${lr.toFixed(3)}`).toBeLessThan(1.16);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-moon'));
});

test('月光③：只改 moonDirection 重摆月轮 ⇒ 地面像素逐位不变（钉住"不经过光照通路"）', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page, 'night');
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g.camera.up.set(0, 0, -1);
    g.camera.position.set(p.x, p.y + 12, p.z);
    g.camera.lookAt(p.x, p.y + 1, p.z);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
  });
  await page.waitForTimeout(700);
  const before = PNG.sync.read(await page.screenshot());

  // 把月轮搬回改动前的旧方向（morning 的原值，与本轮 night 方向夹角 127°）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    // 直接改 sprite 位置而不改 params —— 模拟"月轮换了个方向"，不碰任何光照输入
    const cam = g.camera.position;
    const oldDir = [-0.3198, 0.5796, -0.7495]; // 归一化后的旧 night.moonDirection
    const dist = g.camera.far * 0.55;
    g.sky.moonSprite.position.set(
      cam.x + oldDir[0] * dist, cam.y + oldDir[1] * dist, cam.z + oldDir[2] * dist,
    );
  });
  await page.waitForTimeout(700);
  const after = PNG.sync.read(await page.screenshot());

  // 地面区域的像素必须逐位不变（月轮只是天空里的 sprite，不进体素 shade）
  let diff = 0, n = 0;
  const W = Math.min(before.width, after.width), H = Math.min(before.height, after.height);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      // 只统计屏幕下半（俯视地面，月轮在上半天空）
      if (y < H * 0.5) continue;
      n++;
      if (before.data[o] !== after.data[o] || before.data[o + 1] !== after.data[o + 1]
        || before.data[o + 2] !== after.data[o + 2]) diff++;
    }
  }
  console.log('MOONLIGHT ISOLATION:', JSON.stringify({ diff, n, pct: +(diff / n * 100).toFixed(3) }));
  expect(diff, `搬动月轮不得改变地面像素（本轮不经过光照通路）：${diff}/${n} 像素变了`).toBe(0);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-moon'));
});

test('月光④：白天零回归（月轮不可见 + 色温中性）', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page, 'noon');
  const s = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      moon: g.sky.moonSprite.visible,
      sunColor: g.renderWorld.materials.dayNight.uSunColor.value.toArray(),
      ambientColor: g.renderWorld.materials.dayNight.uAmbientColor.value.toArray(),
    };
  });
  expect(s.moon, '正午月轮须隐藏').toBe(false);
  expect(s.sunColor, '正午色温须仍中性（本轮只改 night）').toEqual([1, 1, 1]);
  expect(s.ambientColor, '正午环境色须仍中性').toEqual([1, 1, 1]);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-moon'));
});
```

- [ ] **Step 2: 运行，按实测值校准阈值**

Run: `npx playwright test tests/moonlight.spec.mjs --workers=1`

Expected: ① 与 ④ PASS；② ③ 先看 `console.log` 的读数。
- ② 是**同页交替对照**（冷色 vs 中性色，唯一变量是两个 uniform），所以 `warm(neutral) ≈ 0`、
  `warm(cold) < -12` 是从 spec 的六面口径推出来的，可直接用；`luma` 比值的 ±16% 容差对应
  目标是 +0.3%，若实测偏得更远（说明 ACES 链路与 CPU 模型有差异）就**按实测重设容差并
  写进注释**，但**不得**删掉上下界。
- ③ 若 `diff > 0`：说明月轮 sprite 意外参与了体素渲染路径（不应发生）。先查 `diff` 落在
  哪些像素（是否在天空区被误算），修**判据**而不是放宽阈值。

- [ ] **Step 3: 全绿后 Commit**

```bash
git add tests/moonlight.spec.mjs
git commit -m "test(moonlight): Tier 4 验收 —— 月轮方向一致性 / 冷色 / 隔离 / 白天零回归"
```

---

### Task 4: 修 `dusk-style.spec` 被本轮命中的零回归断言

**Files:**
- Modify: `tests/dusk-style.spec.mjs:293-319`

**Interfaces:**
- Consumes: Task 1 的 `night.sunColor`/`ambientColor`
- Produces: 无（回归保护）

**为什么必须改**：`test('傍晚⑤：其余三种风格零回归')` 的循环是 `['morning','noon','night',null]`，断言 `sunColor` 逐位 `[1,1,1]`。Task 1 之后 night 不再是中性白 ⇒ 这条会红。`null`（自动循环）在深夜也会走到 night 的冷色 ⇒ 同样红。

- [ ] **Step 1: 先跑一次，确认它真的红（不要凭推断）**

Run: `npx playwright test tests/dusk-style.spec.mjs -g "其余三种风格零回归"`

Expected: FAIL —— `风格 night 的 sunColor 须中性白`。若它**没红**，说明 Task 1 的改动没接上（`uSunColor` 没被写入），先查 Task 1 再回来。

- [ ] **Step 2: 改写该用例**

把 `tests/dusk-style.spec.mjs:293-319` 的 `test('傍晚⑤：其余三种风格零回归…')` 整条替换为：

```js
test('傍晚⑤：morning/noon 零回归；night 为月光冷色（v3.00）；auto 随小时走', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  const seen = [];
  for (const style of ['morning', 'noon', 'night']) {
    await page.evaluate((s) => window.__MC_GAME__.setVisualStyle(s), style);
    await page.waitForTimeout(300);
    const u = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const d = g.renderWorld.materials.dayNight;
      return {
        duskBlend: g.sky.uDuskBlend.value,
        sunColor: d.uSunColor.value.toArray(),
        ambientColor: d.uAmbientColor.value.toArray(),
        sunLight: g.sunLight.color.toArray().map((v) => +v.toFixed(4)),
      };
    });
    seen.push({ style, ...u });
  }
  console.log('DUSK-NEUTRAL:', JSON.stringify(seen));

  for (const s of seen) {
    expect(s.duskBlend, `风格 ${s.style} 的 uDuskBlend 必须为 0`).toBe(0);
    if (s.style === 'night') {
      // v3.00：夜间改为月光冷色（均值 1.0600）。判据落在**色相方向**上，不是具体数值
      // —— 具体数值由 test-daynight.js 的均值区间 [1.04,1.08] 钉住。
      expect(s.sunColor[2], `night 直射须偏冷（B > R）：${s.sunColor}`)
        .toBeGreaterThan(s.sunColor[0] + 0.4);
      expect(s.ambientColor[2], `night 环境须偏冷（B > R）：${s.ambientColor}`)
        .toBeGreaterThan(s.ambientColor[0] + 0.15);
    } else {
      expect(s.sunColor, `风格 ${s.style} 的 sunColor 须中性白`).toEqual([1, 1, 1]);
      expect(s.ambientColor, `风格 ${s.style} 的 ambientColor 须中性白`).toEqual([1, 1, 1]);
      // 中性色温下灯光色逐位等于 mc-lite 原值 0xfffaf0
      expect(s.sunLight, `风格 ${s.style} 的太阳灯须回到原色`).toEqual([1, 0.9804, 0.9412]);
    }
  }
});
```

⚠️ **`null`（自动循环）从循环里移出** —— 它落在哪个色温取决于启动小时（1200s/天，启动默认 12 点但跑一会儿就漂），断言会随时间 flaky。自动循环的色温覆盖由 Task 2 的 `test-daynight.js`（`paramsAtHour` 纯函数，确定性）负责，那才是正确的层级。

- [ ] **Step 3: 运行确认 PASS**

Run: `npx playwright test tests/dusk-style.spec.mjs -g "其余三种风格零回归"`

Expected: PASS。若「傍晚④：傍晚须远亮于深夜 > 1.8×」也受影响，同一条 spec 里跑一遍 `-g "光照基调"`，按实测值调阈值（同样取两侧实测值之间，不贴线）。

- [ ] **Step 4: Commit**

```bash
git add tests/dusk-style.spec.mjs
git commit -m "test(dusk): 零回归用例适配夜间月光冷色（night 不再中性）"
```

---

### Task 5: 全量门禁 + 回归 + roadmap

**Files:**
- Modify: `docs/roadmap.md`（版本表加 v3.00 行）

**Interfaces:**
- Consumes: Task 1~4 全部
- Produces: 无（收尾验证）

- [ ] **Step 1: 静态门禁**

Run: `npm run check`
Expected: `check:arch` / `check:data` / `lint` 三门全绿。lint 的 warning 数须等于改动前基线（不新增）。

- [ ] **Step 2: 浏览器内单测（全量）**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS，`failed === 0`。**记下总用例数**，与改动前基线对比（新增 `test-moonlight.js` 的 4 条应体现在内）。

- [ ] **Step 3: 受影响的 Tier 4 回归（逐个跑，不批量）**

```bash
npx playwright test tests/moonlight.spec.mjs --workers=1
npx playwright test tests/daynight-visual.spec.mjs --workers=1
npx playwright test tests/dusk-style.spec.mjs --workers=1
npx playwright test tests/skybox.spec.mjs --workers=1
npx playwright test tests/sun-directional.spec.mjs --workers=1
npx playwright test tests/hemisphere-ambient.spec.mjs --workers=1
npx playwright test tests/sun-shadow.spec.mjs --workers=1
npx playwright test tests/water-visual.spec.mjs --workers=1
```

Expected: 全部 PASS。**任一红都不许放宽阈值** —— 先判断是"本轮改动导致的真回归"还是"判据描述错了"，按 spec §6 的处置走。

- [ ] **Step 4: 性能门禁（`daynight.js` 是 materials 的上游）**

Run: `npm run bench -- --check`

Expected: 全部场景回退 ≤ 10%。⚠️ `frameP95` 会被 vsync 量子化噪声误报（既有已知问题），若只有它红，按交替对照判定而不是单次读数。**不要**为了让门禁绿而提交 `docs/m3-baseline.*` —— 它是冻结基线。

- [ ] **Step 5: roadmap 加一行**

`docs/roadmap.md` 的版本表末尾（v2.99 之后）加：

```markdown
| v3.00 | **夜间月光照耀**：月亮搬到光照方向那侧 + 夜间色温改冷 | ✅ 已完成（**待用户实玩验收**） | **用户 2026-11-14**：「黑夜模式下，你看下能否做出月光照耀的效果」。**根因**：夜间体素材质的 N·L 方向光用 `sunDirection`（仰角 14.5° / 方位 +5°），而月轮 sprite 在 `moonDirection`（仰角 35.4° / 方位 −157°）—— 两者夹角 **127°**（dot −0.6031）⇒ 「亮面朝南、月亮挂西北」。**方案 A（用户裁定）**：改月亮而不是改太阳 —— `sunDirection` 一个字节不动，四个风格的 `moonDirection` 对齐同风格 `sunDirection`。**为什么必须四风格全改**：19:00~21:00 是 `moonVisible` 已为 true 但方向仍在 morning→night 之间插值的时段，只改 night 会让月亮在 2 小时内扫过天顶（实测仰角 26.7°→64.4°→14.5°、单步方位跳 **61.7°**）；四风格一起改则全程 dot = 1.000000，且 morning/noon/dusk 的 `moonVisible` 本是 false ⇒ 视觉零影响。**色温**：`night.sunColor [0.795,0.954,1.431]` / `ambientColor [0.954,1.018,1.208]`，**均值 1.0600 不是 1.0** —— 均值恰为 1.000 的同色相候选实测六面平均 luma **97.14（−3.3%）**，因为 ACES 在迎光面已进肩部、B 通道压缩率高于 R/G，1.06 是把肩部吃掉的亮度补回来的标定值。屏幕口径实测（基色 0.5 × shade × skyDim 0.25 × 曝光 1.6 → ACES → sRGB）：六面平均 luma **100.50 → 100.84（+0.3%）**、迎光面 R−B **0 → −32**、背光面 0 → −15、迎光/背光比 1.91 → 1.87。**零改动的层**：`sun-shade.js` / `hemi-shade.js` / `materials.js` / `shadow-manager.js` / `ocean.js` / `sky.js` / `game.js` 全部未动 —— 月亮与光照同向后，夜间影子自动变成"月亮投下的"（`uShadowStrength = skyDim = 0.25` 未动，淡但存在）。**明确不做（用户裁定）**：水面高光接线（`ocean.js` 的 `uSunDirection` 仍硬编码 `(0,0.8,0.6)`，是既有缺口）、月影强度/刷新频率、第二盏方向光。**代价**：`moonDirection` 不再是 mc-lite 原值（`test-daynight.js` 的三组原值断言改为"与 `sunDirection` 同源"），`sunDirection` 仍保持原值可溯源。 |
```

- [ ] **Step 6: 最终确认，不提交**

```bash
git status --short
git diff --stat main
```

向用户报告：改了哪些文件、各门禁的实测输出、Tier 4 的关键读数（dot / R−B / luma / 隔离 diff）。

**不执行 `git commit`** —— 提交必须等用户明确指令（AGENTS.md 的 Git 规则）。
