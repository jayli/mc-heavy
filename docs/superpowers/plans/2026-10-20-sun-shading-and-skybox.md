# 太阳方向光着色 + mc-lite 天空盒 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 unlit 体素材质加真实 N·L 太阳方向光项（迎光面亮、背光面暗），并搬入 mc-lite 的白天云图 / 夜空星空天空盒（连续日夜交叉淡入）+ 日轮月轮。

**Architecture:** 标定常数与纯函数放 three-free 模块 `src/render/sun-shade.js`（Tier 1 可单测、node 可 import）；TSL 侧只消费这些常数并在**顶点阶段**把面法线（packed bit10-12）与太阳方向做点积，经 float varying 传片元；天空盒走 `scene.backgroundNode` 手工构建双立方图 mix，混合因子由既有 `skyDim` 派生。

**Tech Stack:** 原生 ES Modules + three.js r185.1（WebGPU）+ TSL + Playwright（Tier 4 像素实测）。

**Spec:** `docs/superpowers/specs/2026-10-20-sun-shading-and-skybox-design.md`

## Global Constraints

- 纯 JavaScript（ES2022+）+ JSDoc，禁止 TypeScript，无编译/转译/打包。
- `src/voxel/` `src/gen/` `src/mesh/` `src/workers/` `src/entities/` 不得 import three（`npm run check:arch` 守）。本次新增的 `src/render/sun-shade.js` 与 `src/render/sky-config.js` **也必须 three-free**（node 侧 `check:data` 要 import 它们）。
- 数据只有一份权威（红线 1）：`SUN_AMBIENT` / `SUN_INTENSITY` / 天空盒文件清单各有且只有一个定义点。
- 断言不得静默放宽：既有 Tier 4 的阈值与判据文字逐字不动，受影响者只改**被测 setup**（URL 参数 / fixture uniform）。
- 注释与文档全部中文；每个任务末尾 `npm run lint` 保持 0 error。
- 每完成一个任务跑该任务的验证命令，**不得跳步**；提交信息用 Conventional Commits，**但只在用户明确指令时提交**。

## Review Focus

1. **天空盒朝向镜像** —— 玩家朝东看应是「日出方向」的那张面；错的话天空左右翻，肉眼极易通过。→ Task 4 的像素判据（已知方位的云层梯度）+ Task 3 的探针。
2. **阴影被方向光冲淡** —— 若把 `shadowFactor` 乘在整个 shade 上而非只乘太阳项，影区会从 0.5 变成 0.75。→ Task 2 的 Tier 4（`sun-shadow.spec` 三条冻结比值）。
3. **关掉方向光不是逐位回到现状** —— `uSunStrength=0` 必须让 `sunTerm ≡ 1`（而不是 `SUN_AMBIENT`），否则顶面从 1.0 掉到 0.5、全场景变暗一半。→ Task 1 单测 + Task 2 Tier 4 的「顶面不随开关变化」。
4. **天空盒拖慢冷启动** —— 多 6MB JPEG + 两张 1024² 立方图解码。→ Task 3 的 `worldReady` 耗时实测记录。
5. **fixture 路径无太阳灯** —— `createVoxelMaterials(tex)`（不传 sunLight）时 `shadowKill` 必须退化为 1，不得出现 `shadowFactor` 为 null 的解构崩溃或全黑。→ Task 2 单测 + Task 5 的 fixture 回归。

---

## 任务总览（文件结构）

| 文件 | 责任 |
|---|---|
| `src/render/sun-shade.js`（新） | 太阳方向光标定常数 + 面法线表 + 纯函数 `sunTermFor()` |
| `src/render/sky-config.js`（新） | 天空盒立方图文件清单 / 目录 / 材质标签（纯数据） |
| `src/render/sky.js`（新） | 立方图加载、`backgroundNode` 构建、日轮/月轮 sprite |
| `src/render/materials.js`（改） | 消费 `sun-shade.js` 常数，顶点阶段算 sunDot，片元合成 sunTerm |
| `src/render/daynight.js`（改） | `moonDirection` 插值、`nightBlendOf()`、写 `uSunDirection`/`uNightBlend` |
| `src/core/game.js`（改） | 装配天空盒（失败降级）、月轮跟随、`?skybox=0` |
| `src/main.js`（改） | `skybox` 构造选项 |
| `assets/sky/{day,night}/*.jpg`（新） | 12 张立方图（从 mc-lite 复制） |
| `tools/check-data.mjs`（改） | `[天空盒]` 资源完整性门禁 |

---

### Task 1: 太阳方向光的标定常数与纯函数

**Files:**
- Create: `src/render/sun-shade.js`
- Test: `src/tests/test-sun-shade.js`
- Modify: `src/tests/index.html`（注册测试文件）

**Interfaces:**
- Produces:
  - `SHADOW_FLOOR: number`（值 0.5，从 `materials.js` 迁来；`materials.js` 从本模块 import）
  - `SUN_AMBIENT: number`（≡ `SHADOW_FLOOR`）
  - `SUN_INTENSITY: number`（= `(1 - SUN_AMBIENT) / NOON_SUN_Y`，`NOON_SUN_Y` 由 `VISUAL_STYLES.noon.sunDirection` 归一化后取 y）
  - `FACE_NORMALS: ReadonlyArray<readonly [number, number, number]>`（索引 0..5 = `FACE_DIRS` 口径：+X,−X,+Y,−Y,+Z,−Z）
  - `sunTermFor(normalIndex: number, sunDir: readonly [number,number,number], strength: number, shadowKill: number): number`

- [ ] **Step 1: 写失败测试**

`src/tests/test-sun-shade.js`：

```js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  SHADOW_FLOOR, SUN_AMBIENT, SUN_INTENSITY, FACE_NORMALS, sunTermFor,
} from '../render/sun-shade.js';
import { VISUAL_STYLES, paramsAtHour } from '../render/daynight.js';

const NOON = paramsAtHour(12).sunDirection;

test('sun-shade: SUN_AMBIENT 恒等于 SHADOW_FLOOR（同一语义：太阳被拿走后的环境地板）', () => {
  assertEqual(SUN_AMBIENT, SHADOW_FLOOR, '两个常数必须相等，否则影区与背光面亮度撕裂');
  assertEqual(SHADOW_FLOOR, 0.5, 'SHADOW_FLOOR 是 mc-lite 2.3/(2.3+3.2*0.8)=0.4733 → sRGB 0.71 的标定产物');
});

test('sun-shade: SUN_INTENSITY 由正午太阳方向派生（不是字面量）', () => {
  assertTrue(Math.abs(NOON[1] - 0.8) < 1e-12, `正午太阳方向归一化后 y 应为 0.8，实测 ${NOON[1]}`);
  assertTrue(Math.abs(SUN_INTENSITY - 0.625) < 1e-12, `派生值应为 0.5/0.8=0.625，实测 ${SUN_INTENSITY}`);
});

test('sun-shade: 正午 +Y 面 sunTerm 恒等于 1.0（零回归不变式）', () => {
  const top = sunTermFor(2, NOON, 1, 1);
  assertTrue(Math.abs(top - 1) < 1e-12, `正午顶面必须等于现状的 1.0，实测 ${top}`);
});

test('sun-shade: strength=0 时所有面恒等于 1.0（关掉即逐位回到现状）', () => {
  for (let i = 0; i < 6; i++) {
    assertTrue(Math.abs(sunTermFor(i, NOON, 0, 1) - 1) < 1e-12, `面 ${i} 关掉方向光后必须为 1.0`);
  }
});

test('sun-shade: 正午六面亮度排序 —— 顶面 > 迎光侧 > 背光侧', () => {
  const v = [0, 1, 2, 3, 4, 5].map((i) => sunTermFor(i, NOON, 1, 1));
  // 期望：+Y 1.0 / +Z 0.875 / ±X 0.5 / -Y 0.5 / -Z 0.5
  assertTrue(v[2] > v[4], `顶面(${v[2]}) 须亮于 +Z 面(${v[4]})`);
  assertTrue(v[4] > v[5], `+Z 迎光面(${v[4]}) 须亮于 -Z 背光面(${v[5]})`);
  assertTrue(Math.abs(v[0] - 0.5) < 1e-12, `+X 面${v[0]}（太阳 x 分量为 0 → 恒 ambient）`);
  assertTrue(Math.abs(v[4] - 0.875) < 1e-12, `+Z 面应为 0.875，实测 ${v[4]}`);
});

test('sun-shade: 阴影把太阳只从太阳项里拿走（影区顶面回到 SHADOW_FLOOR）', () => {
  assertTrue(Math.abs(sunTermFor(2, NOON, 1, 0) - SHADOW_FLOOR) < 1e-12, 'shadowKill=0 时顶面 = 地板');
  assertTrue(Math.abs(sunTermFor(2, NOON, 1, 1) - 1) < 1e-12, 'shadowKill=1 时顶面 = 1');
  // shadowKill 不得影响环境地板本身：背光面在影子里仍是地板值
  assertTrue(Math.abs(sunTermFor(5, NOON, 1, 0) - SHADOW_FLOOR) < 1e-12, '背光面影区 = 地板');
});

test('sun-shade: 太阳转向另一边时迎光/背光互换（方向随日夜真的变）', () => {
  const morning = paramsAtHour(7).sunDirection;
  const plusZ = sunTermFor(4, morning, 1, 1);
  const minusZ = sunTermFor(5, morning, 1, 1);
  assertTrue(plusZ > 1, `morning 的 +Z 面应过曝（迎光），实测 ${plusZ}`);
  assertTrue(Math.abs(minusZ - SHADOW_FLOOR) < 1e-12, `morning 的 -Z 面 = 地板，实测 ${minusZ}`);
});

test('sun-shade: FACE_NORMALS 与 mesher 的面序一致（+X,-X,+Y,-Y,+Z,-Z）', () => {
  assertEqual(FACE_NORMALS.length, 6);
  assertEqual(FACE_NORMALS[0].join(','), '1,0,0');
  assertEqual(FACE_NORMALS[1].join(','), '-1,0,0');
  assertEqual(FACE_NORMALS[2].join(','), '0,1,0');
  assertEqual(FACE_NORMALS[3].join(','), '0,-1,0');
  assertEqual(FACE_NORMALS[4].join(','), '0,0,1');
  assertEqual(FACE_NORMALS[5].join(','), '0,0,-1');
  // 六面法线必须与 noon 太阳方向的点积落在预期档位（形状校验，防表被改乱）
  assertTrue(VISUAL_STYLES.noon.sunDirection.length === 3, 'noon 风格数据存在');
});
```

- [ ] **Step 2: 运行测试确认失败**

游戏页起服务后打开 `http://localhost:8081/src/tests/index.html`，或直接：
`npx playwright test --grep` 不适用（Tier 1 在浏览器内跑）。用一条临时脚本读 `window.__MC_TEST_RESULTS__`。
Expected: FAIL —— `src/render/sun-shade.js` 不存在（模块解析失败）。

- [ ] **Step 3: 实现 `src/render/sun-shade.js`**

```js
// src/render/sun-shade.js — 太阳方向光的标定常数与纯函数（**three-free**）
//
// 为什么单独成模块：① Tier 1 单测要能在浏览器内直接 import（不经 three 的 GPU 初始化）；
// ② tools/check-data.mjs（node）要 import 它断言常数关系；③ materials.js 的 TSL 与单测的
// CPU 参考实现必须在**同一份常数**上求值（红线 1 —— 两处各写一份字面量会漂移出
// 「单测说该亮、GPU 实际不亮」的撕裂）。
import { VISUAL_STYLES } from './daynight.js';

/** 影区/背光面的环境地板。mc-lite 阴影只移除方向光贡献，AmbientLight 保留 →
 *  影区亮度 ≈ 2.3/(2.3+3.2×0.8) = 0.4733（顶面）~0.55（侧面），取 0.5。
 *  v1.45 起同时是阴影地板（见 materials.js 的阴影混合模型）。 */
export const SHADOW_FLOOR = 0.5;

/** 太阳项的环境地板 —— **恒等于 SHADOW_FLOOR**（同一语义）。 */
export const SUN_AMBIENT = SHADOW_FLOOR;

/** 面法线（索引与 mesher 的 FACE_DIRS / packed bit10-12 完全同序）。 */
export const FACE_NORMALS = Object.freeze([
  Object.freeze([1, 0, 0]), Object.freeze([-1, 0, 0]),
  Object.freeze([0, 1, 0]), Object.freeze([0, -1, 0]),
  Object.freeze([0, 0, 1]), Object.freeze([0, 0, -1]),
]);

/** 正午太阳方向归一化后的 y 分量（从风格数据派生，不写字面量）。 */
const NOON = VISUAL_STYLES.noon.sunDirection;
const NOON_LEN = Math.sqrt(NOON[0] ** 2 + NOON[1] ** 2 + NOON[2] ** 2);
export const NOON_SUN_Y = NOON[1] / NOON_LEN;

/** 太阳强度：使「正午顶面 sunTerm ≡ 1.0」（零回归不变式）的唯一取值。 */
export const SUN_INTENSITY = (1 - SUN_AMBIENT) / NOON_SUN_Y;

/**
 * 太阳项（CPU 参考实现，与 materials.js 的 TSL 同公式）。
 * @param {number} normalIndex 0..5（FACE_NORMALS 索引）
 * @param {readonly number[]} sunDir 已归一化的太阳方向
 * @param {number} strength `uSunStrength`（0 = 关闭，逐位回到无方向光的现状）
 * @param {number} shadowKill `(shadowFactor - SHADOW_FLOOR)/(1 - SHADOW_FLOOR)` 钳到 [0,1]；
 *   无太阳灯（fixture）时传 1
 */
export function sunTermFor(normalIndex, sunDir, strength, shadowKill) {
  const n = FACE_NORMALS[normalIndex];
  const dot = Math.max(n[0] * sunDir[0] + n[1] * sunDir[1] + n[2] * sunDir[2], 0);
  const full = SUN_AMBIENT + SUN_INTENSITY * dot * shadowKill;
  return 1 + (full - 1) * strength; // mix(1, full, strength)
}
```

- [ ] **Step 4: 注册测试并跑**

`src/tests/index.html` 的 import 列表追加（放在 `import './test-daynight.js';` 之后）：
```js
    import './test-sun-shade.js';
```
Run: 打开 `http://localhost:8081/src/tests/index.html`，读 `window.__MC_TEST_RESULTS__`。
Expected: `passed` 增加 9，`failed=0`。

- [ ] **Step 5: 让 `materials.js` 从新模块取 `SHADOW_FLOOR`（删掉旧定义）**

`src/render/materials.js` 顶部加 `import { SHADOW_FLOOR, SUN_AMBIENT, SUN_INTENSITY, FACE_NORMALS } from './sun-shade.js';`
并删除本文件里 `export const SHADOW_FLOOR = 0.5;` 那段（连同 `@param` 注释一起迁到 `sun-shade.js` 已写好的位置）。

Run: `npm run check && npx playwright test tests/sun-shadow.spec.mjs`
Expected: `check` 0 error；`sun-shadow.spec` 全绿（此步只是搬常数，行为不变）。

- [ ] **Step 6: 提交**（**等用户明确指令**，下同）
```bash
git add src/render/sun-shade.js src/tests/test-sun-shade.js src/tests/index.html src/render/materials.js
git commit -m "feat(render): 新增太阳方向光标定模块（常数与 CPU 参考实现）"
```

---

### Task 2: materials.js 接方向光 + Tier 4 像素验收

**Files:**
- Modify: `src/render/materials.js`（unicode: colorNode 合成部分）
- Test: `tests/sun-directional.spec.mjs`

**Interfaces:**
- Consumes: `SUN_AMBIENT` / `SUN_INTENSITY` / `SHADOW_FLOOR`（Task 1）
- Produces: `createVoxelMaterials()` 返回的 `dayNight` 句柄新增两项 —— `uSunDirection`（`THREE.Vector3` uniform，默认 = 正午太阳方向）与 `uSunStrength`（float uniform，默认 1.0）。两者在 `sunLight = null` 的 fixture 路径上同样存在。

- [ ] **Step 1: 写失败的 Tier 4 spec**

`tests/sun-directional.spec.mjs`（结构照抄 `tests/sun-shadow.spec.mjs` 的 `setupShadowPlatform` / `measureRegions` 手法）：

```js
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

const URL = '/?vd=4&seed=12345&style=noon';

function regionRGB(png, x, y, half) {
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

async function waitWorldSettled(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.scheduler?.stats().meshInflight === 0,
    null, { timeout: 60_000 });
}

test('方向光：太阳照到的面更亮、背面更暗，且顶面不受开关影响', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  // ---- 隔离场景：P 高度全 stone 平台 + 一堵沿 X 的墙（P+1..P+3），相机在墙的两侧分别正视 ----
  const P = 80;
  const info = await page.evaluate((P) => {
    const g = window.__MC_GAME__;
    const ox = Math.floor(g.player.physics.pos.x), oz = Math.floor(g.player.physics.pos.z);
    const stone = g.registry.idOf('stone');
    for (let y = P + 1; y <= 95; y++) {
      for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) {
        if (g.world.getBlockId(ox + dx, y, oz + dz) !== 0) g.editor.setBlock({ x: ox + dx, y, z: oz + dz, id: 0 });
      }
    }
    for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) {
      g.editor.setBlock({ x: ox + dx, y: P, z: oz + dz, id: stone });
    }
    // 墙：x ∈ [ox-8, ox+8]，y ∈ [P+1, P+3]，z = oz
    for (let dx = -8; dx <= 8; dx++) for (let dy = 1; dy <= 3; dy++) {
      g.editor.setBlock({ x: ox + dx, y: P + dy, z: oz, id: stone });
    }
    g.pushModal('tier4-sun');
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) el.style.display = 'none';
    return { ox, oz };
  }, P);
  await waitWorldSettled(page);

  /** 把相机摆到墙的 ±Z 一侧正视墙面，返回读到的墙面亮度 */
  async function faceBrightness(side, strength) {
    await page.evaluate(({ ox, oz, P, side, strength }) => {
      const g = window.__MC_GAME__;
      const u = g.renderWorld.materials.dayNight.uSunStrength;
      expect(u, 'uSunStrength 句柄须存在').toBeTruthy; // 句柄缺失时下面的亮度断言会 FAIL
      if (u) u.value = strength;
      g.camera.up.set(0, 1, 0);
      g.camera.position.set(ox + 0.5, P + 2, oz + side * 10);
      g.camera.lookAt(ox + 0.5, P + 2, oz);
      g.camera.updateMatrixWorld();
      g.camera.updateProjectionMatrix();
    }, { ox: info.ox, oz: info.oz, P, side, strength });
    await page.waitForTimeout(700);
    const px = await page.evaluate(({ ox, oz, P, side }) => {
      const g = window.__MC_GAME__;
      const v = new g.camera.position.constructor(ox + 0.5, P + 2, oz + side * 0.001);
      v.project(g.camera);
      return { x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
               y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight) };
    }, { ox: info.ox, oz: info.oz, P, side });
    const png = PNG.sync.read(await page.screenshot());
    const c = regionRGB(png, px.x, px.y, 8);
    return (c.r + c.g + c.b) / 3;
  }

  const litOff = await faceBrightness(1, 0);    // +Z 面，方向光关闭
  const darkOff = await faceBrightness(-1, 0);  // -Z 面，方向光关闭
  const litOn = await faceBrightness(1, 1);     // +Z 面（noon 太阳 z=+0.6 → 迎光）
  const darkOn = await faceBrightness(-1, 1);   // -Z 面（背光）
  console.log('SUN-DIRECTIONAL:', JSON.stringify({
    litOff: +litOff.toFixed(1), darkOff: +darkOff.toFixed(1),
    litOn: +litOn.toFixed(1), darkOn: +darkOn.toFixed(1),
    ratioOff: +(litOff / darkOff).toFixed(3), ratioOn: +(litOn / darkOn).toFixed(3),
  }));

  // sanity floor：四个读数都须读到墙面几何而非黑屏/天空
  for (const [k, v] of Object.entries({ litOff, darkOff, litOn, darkOn })) {
    expect(v, `${k} 须读到墙面几何：${v.toFixed(1)}`).toBeGreaterThan(20);
  }
  // ① 关闭方向光时两面亮度相同（证明读法本身无偏，判据有效）
  expect(litOff / darkOff, '关闭时两面须等亮（否则读法有偏）').toBeGreaterThan(0.95);
  expect(litOff / darkOff, '关闭时两面须等亮（否则读法有偏）').toBeLessThan(1.05);
  // ② 打开后迎光面显著亮于背光面（双侧：既要有对比度，又不能失控）
  expect(litOn / darkOn, `迎光面须显著更亮（理论 1.75）`).toBeGreaterThan(1.45);
  expect(litOn / darkOn, `对比度不得失控（理论 1.75）`).toBeLessThan(2.1);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-sun'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/sun-directional.spec.mjs`
Expected: FAIL —— `uSunStrength` 句柄不存在（`u` 为 undefined）→ 两面亮度比恒 ≈1 → 断言 ② FAIL。

- [ ] **Step 3: 在 `materials.js` 里接方向光**

在 `uShadowStrength` 定义之后加：

```js
// ---- 太阳方向光（N·L，§4.4.3 v1.58）----
// 面法线走 packed bit10-12（mesher 早已写入、此前零消费点）。**必须在顶点阶段**算成 float
// varying：片元直接读 packed 会被 three.webgpu.js:65404 对 int 类型强制 `flat` 插值。
const uSunDirection = uniform(new THREE.Vector3(NOON_DIR[0], NOON_DIR[1], NOON_DIR[2]));
/** 0 = 关闭（sunTerm ≡ 1，逐位回到无方向光的现状）/ 1 = 满强度。A/B 探针与像素判据用。 */
const uSunStrength = uniform(1.0);
```

（`NOON_DIR` 从 `sun-shade.js` 取：`import { NOON_SUN_DIR }` —— Task 1 需补一个 `export const NOON_SUN_DIR`，值为归一化后的正午方向数组；若 Task 1 已写成 `NOON_SUN_Y`，此处改为直接 `new THREE.Vector3(...VISUAL_STYLES.noon.sunDirection).normalize()`。）

在 `vSkyShade` / `vBlockShade` 定义之后加：

```js
// 面法线解码：packed bit10-12 = 世界面索引 0..5（FACE_NORMALS 同序）。逐顶点常量 → float varying。
const worldFace = packed.shiftRight(10).bitAnd(7);
const marchTable = FACE_NORMALS.map((n) => vec3(n[0], n[1], n[2]));
const faceNormal = marchTable[0];
const selectChain = marchTable.slice(1).reduce(
  (acc, n, i) => acc.select(worldFace.equal(i + 1), n), faceNormal);
const vSunDot = varying(
  vertexStage(max(dot(selectChain, uSunDirection), 0)), 'vSunDot');
```

在 `makeMaterial` 内、`shade` 计算处替换为：

```js
// 太阳项 = 环境地板 + 强度 × N·L × 阴影（阴影**只**作用在太阳项上，见 spec §2.3）
const shadowKill = shadowFactor
  ? float(1).sub(float(1).sub(shadowFactor).div(1 - SHADOW_FLOOR)).clamp(0, 1)
  : float(1);
const sunTermFull = float(SUN_AMBIENT).add(mul(float(SUN_INTENSITY), mul(vSunDot, shadowKill)));
const sunTerm = mix(float(1), sunTermFull, uSunStrength);
const shade = receivesShadow
  ? max(mul(mul(vSkyShade, sunTerm), 1), vBlockShade)   // 即 max(vSkyShade*sunTerm, vBlockShade)
  : max(vSkyShade, vBlockShade);                        // transparent 通道不接太阳（既有水面高光自带）
```

⚠️ `max`/`mul` 调用保持现有 import；`dot`/`vec3`/`mix` 若未 import 需补。
⚠️ **不得**把 `sunTerm` 乘在 `vBlockShade` 上（火把在洞里要照样亮）。
⚠️ 原有 `shadeLit` / `shadeUnlit` 变量随之调整，`shadowFactor` 不再直接乘 `vSkyShade`。

最后在返回的 `dayNight` 句柄里加 `uSunDirection`、`uSunStrength`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/sun-directional.spec.mjs`
Expected: PASS，`ratioOff` ≈ 1.00（±0.05）、`ratioOn` ≈ 1.75。

- [ ] **Step 5: 跑既有阴影与 AO 回归**

Run: `npx playwright test tests/sun-shadow.spec.mjs tests/ao-visual.spec.mjs tests/ao-corner-visual.spec.mjs tests/render-world.spec.mjs`
Expected: 全绿。若 `sun-shadow` 的三条冻结比值漂移，**停下来报告**（理论应逐位不变：被测点是顶面，受光 1.0 / 影区 0.5）。

- [ ] **Step 6: 提交**

```bash
git add src/render/materials.js src/render/sun-shade.js tests/sun-directional.spec.mjs
git commit -m "feat(render): 体素材质接太阳 N·L 方向光（迎光更亮、背光更暗）"
```

---

### Task 3: DayNight 驱动太阳方向 / 夜间混合 / 月亮方向

**Files:**
- Modify: `src/render/daynight.js`
- Test: `src/tests/test-daynight.js`（追加）

**Interfaces:**
- Consumes: `voxelUniforms.uSunDirection`（Task 2，可选句柄）
- Produces:
  - `nightBlendOf(params: {skyDim:number}): number` —— 0（正午）~1（深夜）
  - `DayNight` 构造选项新增 `skyUniforms?: { uNightBlend?: {value:number} } | null`
  - `VISUAL_STYLES[key]` 新增 `moonDirection: [number,number,number]` 与 `moonVisible: boolean`、`moonSize: number`
  - `DayNight.params` 返回的 `moonDirection` **已归一化**

- [ ] **Step 1: 写失败测试（追加到 `src/tests/test-daynight.js`）**

```js
// —— 夜间混合与月亮方向（v1.58 天空盒）——

test('nightBlendOf：正午 0 / 深夜 1 / 晨居中且单调', async () => {
  const { nightBlendOf } = await import('../render/daynight.js');
  const noon = nightBlendOf(paramsAtHour(12));
  const night = nightBlendOf(paramsAtHour(0));
  const morning = nightBlendOf(paramsAtHour(7));
  assertEqual(noon, 0, '正午 = 0（全白天云图）');
  assertTrue(Math.abs(night - 1) < 1e-12, `深夜 = 1（全星空），实测 ${night}`);
  assertTrue(morning > 0 && morning < 1, `晨须居中，实测 ${morning}`);
  // 单调：早上 6→12 应单调下降
  let prev = nightBlendOf(paramsAtHour(6));
  for (let h = 6.25; h <= 12; h += 0.25) {
    const cur = nightBlendOf(paramsAtHour(h));
    assertTrue(cur <= prev + 1e-12, `6→12 须单调不增：h=${h} ${prev}->${cur}`);
    prev = cur;
  }
});

test('nightBlendOf：钳制在 [0,1]（skyDim 越界不得溢出）', async () => {
  const { nightBlendOf } = await import('../render/daynight.js');
  assertEqual(nightBlendOf({ skyDim: 2 }), 0, 'skyDim > 1 夹到 0');
  assertEqual(nightBlendOf({ skyDim: -1 }), 1, 'skyDim < night 夹到 1');
});

test('三风格 moonDirection 是 mc-lite 原值，且插值后仍是单位向量', () => {
  const m = VISUAL_STYLES[VISUAL_STYLE_KEYS.MORNING].moonDirection;
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON].moonDirection;
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT].moonDirection;
  assertEqual(m.join(','), '-0.38,0.45,-0.81');
  assertEqual(n.join(','), '-0.25,0.5,-0.82');
  assertEqual(k.join(','), '-0.32,0.58,-0.75');
  for (const h of [0, 4, 7.5, 12, 18.5, 23]) {
    const d = paramsAtHour(h).moonDirection;
    const len = Math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2);
    assertTrue(Math.abs(len - 1) < 1e-6, `h=${h}: |len-1| = ${Math.abs(len - 1)}`);
  }
});

test('DayNight：写 uSunDirection 与 uNightBlend（句柄缺失时不抛错）', () => {
  const seen = { sun: null, blend: null };
  const voxelUniforms = {
    uSkyDim: { value: 0 }, uBlockBoost: { value: 0 }, uShadowStrength: { value: 0 },
    uSunDirection: { value: { set(x, y, z) { seen.sun = [x, y, z]; } } },
  };
  const skyUniforms = { uNightBlend: { value: -1 } };
  const dayNight = new DayNight({
    scene: {},
    fog: { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } },
    voxelUniforms, skyUniforms,
  });
  dayNight.setTime(12);
  assertVecClose(seen.sun, normalize([0, 0.8, 0.6]), 1e-9, 'setTime(12) 写入的太阳方向');
  assertEqual(skyUniforms.uNightBlend.value, 0, '正午 nightBlend = 0');
  dayNight.setTime(0);
  assertTrue(Math.abs(skyUniforms.uNightBlend.value - 1) < 1e-12, '深夜 nightBlend = 1');
  // 不带 skyUniforms 构造不得抛错（既有调用方）
  makeDayNightStub();
});
```

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL —— `nightBlendOf` 未导出、`moonDirection` 为 undefined、uniform 未被写入。

- [ ] **Step 3: 实现**

`VISUAL_STYLES` 三项各补 `moonDirection`（morning `[-0.38,0.45,-0.81]` / noon `[-0.25,0.5,-0.82]` / night `[-0.32,0.58,-0.75]`，mc-lite `Engine.js:75/108/123` 原值）与 `moonVisible`（false/false/true）、`moonSize`（20/18/34）。

`lerpParams` 增加 `moonDirection` 三分量插值；`paramsAtHour` 末尾与 `get params` 里对 `moonDirection` 同样走 `normalizeDirection`（与 `sunDirection` 同一处、同一函数 —— 不得各写一份）。

新增导出：

```js
/**
 * 夜间程度 0..1（天空盒双图交叉淡入因子）。
 * 由既有 skyDim 派生而非新增权威：正午 skyDim=1 → 0；skyDim 降到 night 的 0.25 → 1。
 * 于是「天空变暗」与「星空浮现」天然同步，随关键帧插值连续变化（无跳帧）。
 */
export function nightBlendOf(params) {
  const nightDim = VISUAL_STYLES.night.skyDim;
  const raw = (1 - params.skyDim) / (1 - nightDim);
  return Math.min(1, Math.max(0, raw));
}
```

构造函数新增 `skyUniforms = null` 参数并存为 `this.skyUniforms`；`_apply(p)` 在写 `uShadowStrength` 之后加：

```js
// 太阳方向写给体素材质的方向光（句柄由 createVoxelMaterials 提供；fixture 无该句柄时跳过）
const uSunDirection = this.voxelUniforms.uSunDirection;
if (uSunDirection && uSunDirection.value && typeof uSunDirection.value.set === 'function') {
  const d = normalizeDirection(p.sunDirection);
  uSunDirection.value.set(d[0], d[1], d[2]);
}
const uNightBlend = this.skyUniforms && this.skyUniforms.uNightBlend;
if (uNightBlend) uNightBlend.value = nightBlendOf(p);
```

⚠️ 归一化后的方向已在方法末尾由 `this.onSunDirection(normalizeDirection(p.sunDirection))` 算出一次；**复用同一个变量**，不要为写 uniform 再归一化一遍（两处各算一次就会漂移，且 `_apply` 每帧跑）。

- [ ] **Step 4: 跑测试确认通过**

Run: 浏览器内单测页 + `npx playwright test tests/sun-directional.spec.mjs tests/sun-shadow.spec.mjs tests/daynight-visual.spec.mjs`
Expected: 全绿，Tier 1 `failed=0`。

- [ ] **Step 5: 提交**

```bash
git add src/render/daynight.js src/tests/test-daynight.js
git commit -m "feat(render): DayNight 驱动太阳方向 uniform、夜间混合因子与月亮方向"
```

---

### Task 4: 天空盒资源 + 数据契约门禁

**Files:**
- Create: `assets/sky/day/{posx,negx,posy,negy,posz,negz}.jpg`、`assets/sky/night/{同样 6 张}.jpg`
- Create: `src/render/sky-config.js`
- Test: `tools/check-data.mjs` 的 `checkSkyboxAssets()`

**Interfaces:**
- Produces:
  - `SKY_FACE_FILES: readonly string[]`（6 个文件名，`CubeTextureLoader` 的固定顺序）
  - `SKY_SETS: { day: string, night: string }`（目录路径，相对站点根）
  - `SKY_DIR: string`（根目录 = `'assets/sky'`，供门禁拼路径）

- [ ] **Step 1: 复制资源**

```bash
mkdir -p assets/sky/day assets/sky/night
cp /Users/bachi/jaylli/mc-lite/src/assets/skyBox4/*.jpg assets/sky/day/
cp /Users/bachi/jaylli/mc-lite/src/assets/skyBox1/*.jpg assets/sky/night/
ls -l assets/sky/day assets/sky/night   # 各须 6 张、各 1024x1024
```

- [ ] **Step 2: 写失败测试（门禁环节）**

在 `tools/check-data.mjs` 追加函数并在主流程显式调用（放在 `checkTurretArmorTexture();` 之后）：

```js
// ---------------------------------------------------------------- [13] 天空盒资源

/**
 * [天空盒] 契约：清单是唯一权威（`sky-config.js`），12 张立方图必须都在磁盘上。
 *
 * 缺一张的后果是**静默的**：`CubeTextureLoader` 会把缺失面向的 onError 吞成空白面 →
 * 天空出现一块纯黑/纯灰，不报错、不阻断启动。故只能静态断言。
 * ⚠️ 主流程是逐个显式调用 —— 漏了本行则门禁永不执行。
 */
function checkSkyboxAssets() {
  const { SKY_FACE_FILES, SKY_SETS, SKY_DIR } = SKYBOX;
  let missing = 0;
  for (const [name, dir] of Object.entries(SKY_SETS)) {
    for (const face of SKY_FACE_FILES) {
      const p = path.join(ROOT, dir, face);
      if (!fs.existsSync(p)) { failures.push(`[天空盒] ${name} 缺面：${path.relative(ROOT, p)}`); missing++; }
    }
  }
  if (!missing) {
    infos.push(`[天空盒] ${Object.keys(SKY_SETS).length} 套 × ${SKY_FACE_FILES.length} 面上传完整（${SKY_DIR}）`);
  }
}
```

顶部 import 区加：
```js
const SKYBOX = await import('../src/render/sky-config.js');
```

主流程加一行 `checkSkyboxAssets();   // v1.58：天空盒立方图完整性（⚠️ 漏了本行则门禁永不执行）`。

- [ ] **Step 3: 跑门禁确认失败**

Run: `npm run check:data`
Expected: FAIL —— 无法解析 `../src/render/sky-config.js`。

- [ ] **Step 4: 实现 `src/render/sky-config.js`**

```js
// src/render/sky-config.js — 天空盒立方图清单（**three-free** 纯数据）
//
// 为什么单独成模块：`tools/check-data.mjs`（node）要 import 它做资源完整性门禁，
// 而 `sky.js` 要用同一份清单去 `CubeTextureLoader`（红线 1：清单只有一份权威）。
// 资源来源 = mc-lite `src/assets/skyBox4`（白天云）/ `skyBox1`（夜空星空），原样复制未重编码。
// ⚠️ `skyBox2`（日落）**不搬** —— mc-lite 自身零引用（`grep skyBox2 src/` 无消费点）。

/** CubeTextureLoader 的固定面序（+X, −X, +Y, −Y, +Z, −Z）。 */
export const SKY_FACE_FILES = Object.freeze([
  'posx.jpg', 'negx.jpg', 'posy.jpg', 'negy.jpg', 'posz.jpg', 'negz.jpg',
]);

/** 天空盒根目录（相对站点根；静态服务器不剥离 assets 前缀）。 */
export const SKY_DIR = 'assets/sky';

/** 两套立方图：day = 白天云层（mc-lite skyBox4），night = 星空（mc-lite skyBox1）。 */
export const SKY_SETS = Object.freeze({
  day: `${SKY_DIR}/day`,
  night: `${SKY_DIR}/night`,
});
```

- [ ] **Step 5: 跑门禁确认通过**

Run: `npm run check:data`
Expected: 输出含 `✓ [天空盒] 2 套 × 6 面上传完整（assets/sky）`，退出码 0。

- [ ] **Step 6: 提交**

```bash
git add assets/sky src/render/sky-config.js tools/check-data.mjs
git commit -m "feat(assets): 搬入 mc-lite 白天/夜空天空盒立方图 + 资源完整性门禁"
```

---

### Task 5: sky.js 天空盒与日轮月轮 + Game 接线

**Files:**
- Create: `src/render/sky.js`
- Modify: `src/core/game.js`、`src/main.js`

**Interfaces:**
- Consumes: `SKY_FACE_FILES` / `SKY_SETS`（Task 4）、`DayNight` 的 `skyUniforms` 选项与 `params.moonDirection` / `moonVisible` / `moonSize`（Task 3）
- Produces:
  - `setupSky(scene: THREE.Scene, opts: { camera: THREE.Camera }): Promise<{ uNightBlend, moonSprite, sunSprite, dispose(): void }>`
  - `Game` 构造选项新增 `skybox?: boolean`（默认 `true`）

- [ ] **Step 1: 实现 `src/render/sky.js`**

结构（完整实现，无占位）：

```js
// src/render/sky.js — 天空盒（双立方图交叉淡入）+ 日轮/月轮（v1.58，来源 mc-lite Engine.js:429-527）
//
// 与 mc-lite 的**两处有意偏离**（spec §3.4）：
//  ① 不做 `backgroundBlurriness`（它会走 pmremTexture 路径，与手工 backgroundNode 冲突；
//     且那是 mc-lite 离散切风格的补偿值，交叉淡入下星星该是清晰的）。
//  ② 天空随连续日夜插值，而非点按钮时硬切换。
import * as THREE from 'three';
import { cubeTexture, mix, normalWorldGeometry, uniform } from 'three/tsl';
import { SKY_FACE_FILES, SKY_SETS } from './sky-config.js';

function loadCube(dir) {
  return new THREE.CubeTextureLoader().setPath(`${dir}/`).load([...SKY_FACE_FILES]);
}

function configureCube(tex) { /* sRGB + Linear/LinearMipmapLinear + generateMipmaps，照 mc-lite :515-522 */ }

function makeMoonSprite() { /* canvas 256²：先柔和月晕再画满月圆盘，照 mc-lite :463-495 */ }
function makeSunSprite() { /* canvas 128²：三层暖色径向渐变，照 mc-lite :429-462 */ }

export async function setupSky(scene) {
  // 两张立方图并行加载（CubeTextureLoader 内部是 Image 对象，load 同步返回，加载在后台完成）
  // → 用 Promise.all 等 onLoad，任一失败则 reject（调用方降级为纯色背景）
  ...
  const uNightBlend = uniform(0);
  const dir = normalWorldGeometry;   // three 背景网格的上下文提供的世界方向
  const dayNode = cubeTexture(dayCube, dir);
  const nightNode = cubeTexture(nightCube, dir);
  scene.backgroundNode = mix(dayNode, nightNode, uNightBlend);
  scene.background = null;           // 交给 backgroundNode；DayNight 的 Color.set 路径自动跳过
  ...
  return { uNightBlend, moonSprite, sunSprite, dispose() {...} };
}

/** 日轮/月轮跟随（相机位移 + 方向 × 距离，等比缩放；只在既有重定位节奏里调用，不每帧算） */
export function placeCelestial(sprite, camera, dir, size) { ... }
```

要点（实现必须满足）：
- 加载用 `Promise` 包 `CubeTextureLoader.load(urls, onLoad, undefined, onError)`，`onError` → reject。
- `scene.background = null` 与 `scene.backgroundNode = ...` 同时设置（three 的 `getBackgroundNode()` 优先读 `scene.backgroundNode`）。
- 距离取 `camera.far * 0.55`，缩放 `size * (distance / 150)`（mc-lite 的 150 是固定距离基准）。
- 两个 sprite 都 `fog: false`、`depthTest: true`、`renderOrder` 默认；构造时 `visible = false`。
- `dispose()` 释放两张立方图与两张 canvas 纹理、清 `scene.backgroundNode`。

- [ ] **Step 2: 接线 `game.js` 与 `main.js`**

`main.js` 加（照 `?shadows=0` 的口径，默认开则只有 `'0'` 关）：
```js
  // ?skybox=0 关闭天空盒（退回纯色天空，观测口径与 v1.57 逐位相同）——既有 spec 的隔离入口
  const skybox = params.get('skybox') !== '0';
```
并传入 `new Game({ ..., skybox })`。

`game.js` 构造选项加 `skybox = true` → `this._skyboxOption = skybox`；在 `start()` 里、`this.dayNight` 创建**之前**装配天空盒（DayNight 需要 `skyUniforms` 句柄）：

```js
    // 天空盒（v1.58）：必须在 DayNight 之前建 —— 它的 uNightBlend 句柄要传给 DayNight。
    // 加载失败不阻断启动（与丧尸头部/炮塔装甲纹理同一容错口径）：退回既有纯色背景。
    this.sky = null;
    if (this._skyboxOption) {
      try {
        this.sky = await setupSky(this.scene);
      } catch (e) {
        console.warn('[game] 天空盒加载失败，退回纯色天空：', e);
        this.scene.backgroundNode = null;
        this.scene.background = new THREE.Color(0x87ceeb);
      }
    }
```
DayNight 构造处加 `skyUniforms: this.sky ? { uNightBlend: this.sky.uNightBlend } : null`。

帧循环里在 `_updateSunPosition()` 之后（同一节奏，不每帧）刷新日轮/月轮位置与可见性：
```js
      this._updateCelestial();   // 日轮/月轮跟随（内部判 this.sky 为空即 return）
```

`_updateCelestial()` 实现：从 `dayNight.params` 取 `sunDirection`/`moonDirection` 与当前风格 `moonVisible`/`moonSize`；月轮 `visible = moonVisible === true`；位置 = `camera.position + dir * (camera.far * 0.55)`。

- [ ] **Step 3: 手工验证 + 探针**

启动 `npm start`，打开 `http://localhost:8081/?vd=4&seed=12345`，记录：
1. 天空是否显示云层贴图（不是纯蓝色）；
2. 把 `dayNight.setTime(0)` 后天空是否变星空；
3. 朝东/朝西看时云层是否连续（无接缝黑边）→ 若出现「左右镜像」，在两套立方图的 `posx/negx` 上换位并复测，结论写进注释；
4. 控制台无 GPU 错误；
5. `performance.now()` 从导航到 `worldReady` 的耗时（与 v1.57 对比，记录到报告）。

- [ ] **Step 4: 跑既有回归**

Run: `npx playwright test tests/render-world.spec.mjs tests/weapon-view.spec.mjs tests/harness.spec.mjs`
Expected: 全绿（`test-render-world.html` 用 `createVoxelMaterials(tex)` 无太阳灯路径，`shadowKill=1`，不得崩）。

- [ ] **Step 5: 提交**

```bash
git add src/render/sky.js src/core/game.js src/main.js
git commit -m "feat(render): 天空盒双图交叉淡入 + 日轮月轮，支持 ?skybox=0 降级"
```

---

### Task 6: 天空盒 Tier 4 像素验收

**Files:**
- Test: `tests/skybox.spec.mjs`

**Interfaces:**
- Consumes: `window.__MC_GAME__.sky`（`uNightBlend` 句柄 + 两个 sprite）、`dayNight.setTime()`、`dayNight.params`

- [ ] **Step 1: 写测试**

```js
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 天空区（屏幕上半、避开地面）像素方差 —— 纯色天空方差≈0，贴图天空方差大 */
function skyVariance(png) {
  const x0 = Math.round(png.width * 0.3), x1 = Math.round(png.width * 0.7);
  const y0 = Math.round(png.height * 0.02), y1 = Math.round(png.height * 0.12);
  const vals = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * png.width + x) * 4;
    vals.push((png.data[o] + png.data[o + 1] + png.data[o + 2]) / 3);
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { mean, variance: vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length };
}

test('天空盒：贴图真的在渲染（不是纯色）+ 日夜混合生效 + 月轮仅夜间可见', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=4&seed=12345&style=noon');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 固定机位抬头看天：避免地形/建筑进入采样区
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.pushModal('tier4-sky');
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) el.style.display = 'none';
    g.camera.up.set(0, 1, 0);
    g.camera.position.set(g.player.physics.pos.x, g.player.physics.pos.y + 20, g.player.physics.pos.z);
    g.camera.lookAt(g.player.physics.pos.x + 8, g.player.physics.pos.y + 60, g.player.physics.pos.z + 8);
    g.camera.updateMatrixWorld();
  });
  await page.waitForTimeout(2500);

  const noon = skyVariance(PNG.sync.read(await page.screenshot()));
  const night = await (async () => {
    await page.evaluate(() => window.__MC_GAME__.dayNight.setTime(0));
    await page.waitForTimeout(1200);
    return skyVariance(PNG.sync.read(await page.screenshot()));
  })();
  console.log('SKYBOX:', JSON.stringify({ noon, night }));

  // ① 贴图天空：方差显著（纯色天空方差 ≈ 0）
  expect(noon.variance, `正午天空须是贴图而非纯色：variance=${noon.variance.toFixed(2)}`).toBeGreaterThan(4);
  // ② 昼夜不同：夜间均值显著更暗
  expect(night.mean, `夜间天空须显著暗于正午：noon=${noon.mean.toFixed(1)} night=${night.mean.toFixed(1)}`)
    .toBeLessThan(noon.mean * 0.6);
  // ③ 混合因子与 skyDim 同向
  const blend = await page.evaluate(() => ({
    night: window.__MC_GAME__.sky.uNightBlend.value,
    skyDim: window.__MC_GAME__.dayNight.params.skyDim,
  }));
  expect(blend.night, '深夜 uNightBlend 须 ≈1').toBeGreaterThan(0.99);
  expect(blend.skyDim, '深夜 skyDim 须 = 0.25').toBeLessThan(0.3);
  // ④ 月轮仅夜间可见
  const moon = await page.evaluate(() => ({
    nightVisible: window.__MC_GAME__.sky.moonSprite.visible,
  }));
  expect(moon.nightVisible, '夜间月轮须可见').toBe(true);
  await page.evaluate(() => window.__MC_GAME__.dayNight.setTime(12));
  await page.waitForTimeout(600);
  const noonMoon = await page.evaluate(() => window.__MC_GAME__.sky.moonSprite.visible);
  expect(noonMoon, '正午月轮须隐藏').toBe(false);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-sky'));
});
```

- [ ] **Step 2: 跑测试**

Run: `npx playwright test tests/skybox.spec.mjs`
Expected: PASS。若 ① 的方差低于阈值而画面**肉眼是云**，先查采样区是否落在地形上（调机位），**不得**直接降阈值。

- [ ] **Step 3: 提交**

```bash
git add tests/skybox.spec.mjs
git commit -m "test(render): 天空盒 Tier 4 像素验收（贴图在渲染/日夜混合/月轮可见性）"
```

---

### Task 7: 既有 spec 隔离 + 全量回归 + 文档

**Files:**
- Modify: `tests/render-terrain.spec.mjs`、`tests/city-visual.spec.mjs`、`tests/sky-structures.spec.mjs`、`tests/m3-rain.spec.mjs`（用例 URL 加 `&skybox=0`）
- Modify: `docs/phase-1-engine-design.md`（v1.58 修订说明 + §4.4.3 重写）
- Modify: `docs/roadmap.md`、`AGENTS.md`

- [ ] **Step 1: 隔离受影响的 spec（只改被测 setup，断言逐字不动）**

四条用例的 `page.goto` URL 追加 `&skybox=0`：
- `tests/render-terrain.spec.mjs`（`/?vd=8&seed=12345` → 加 `&skybox=0`）
- `tests/city-visual.spec.mjs`（同上）
- `tests/sky-structures.spec.mjs`
- `tests/m3-rain.spec.mjs`（`boot()` 里的 goto）

每条上方补一行中文注释说明理由（照片天空让「±30 内等于 0x87ceeb」的判据失去意义 / 白色雨滴压在白云上看不出）。

- [ ] **Step 2: 跑受影响的四条**

Run: `npx playwright test tests/render-terrain.spec.mjs tests/city-visual.spec.mjs tests/sky-structures.spec.mjs tests/m3-rain.spec.mjs`
Expected: 全绿。

- [ ] **Step 3: 全量回归**

Run: `npx playwright test` + `npm test` 的浏览器内单测（`src/tests/index.html` 读 `__MC_TEST_RESULTS__`）
Expected: 全部 spec 绿；单测 `failed=0`。
⚠️ 三条已知 flaky（`m1-acceptance` / `m3-rain` / `weapons-world-edit`）若贴线 FAIL，单独复跑确认，**不得改阈值**。
⚠️ 若 `ao-visual` / `ao-corner-visual` / `sky-tree-visual` 因方向光漂移而 FAIL：按 spec §5 在**该 fixture**里 `uSunStrength=0` 隔离，并在文件头注明理由；不得改断言。

- [ ] **Step 4: bench 结构门**

Run: `npm run bench -- --check`
Expected: 无 `[回退 ...]` 阻断。背景网格多 1 次 draw（489→490），结构类容差 2%。
⚠️ 不带 `--check` 跑会**重写** `docs/m3-baseline.*` 冻结基线 —— 若误跑，`git checkout docs/m3-baseline.*` 恢复。
⚠️ `frameP95` 门禁若贴线阻断，按既有口径做**交替对照**（同会话内 stash 与改动交错各 2~3 次）判定，不看单次数值。

- [ ] **Step 5: 更新设计文档**

`docs/phase-1-engine-design.md`：
1. 首行版本 `v1.57` → `v1.58`，状态尾巴追加 `+ 太阳方向光着色与天空盒`；
2. 在 v1.57 修订说明之后加 `> v1.58 修订说明：**体素材质接太阳 N·L 方向光 + mc-lite 天空盒**（§4.4.3）`，内容取自本 spec §2/§3/§4 的决策与实测数据（含 `uSunStrength=0` 逐位等价、阴影只乘太阳项、三处有意偏离）；
3. **重写 §4.4.3**（当前是规划期的三行占位）：写入方向光公式与标定推导、天空盒双图淡入与 `nightBlendOf` 派生、日轮月轮廓线、`?skybox=0` 降级、两处有意偏离。

- [ ] **Step 6: 更新 roadmap 与 AGENTS.md**

- `docs/roadmap.md`：把本次改动登记进版本表（v1.58），「后续扩展点」表里「灯/光源」一行补注「太阳方向光已落地（v1.58）」。
- `AGENTS.md`：新增小节「太阳方向光与天空盒沉淀的活跃约束」——至少包含：`uSunStrength=0 必须使 sunTerm≡1`、阴影只能乘太阳项不可乘整个 shade、`SUN_INTENSITY` 必须从 noon 太阳方向派生（改风格要重算）、`scene.background=null` + `backgroundNode` 双设、照片天空会让「纯色天空」判据失效故四条 spec pin `?skybox=0`。

- [ ] **Step 7: 终检**

Run: `npm run check`
Expected: 0 error（`check:arch` + `check:data` + `lint` 全过）。

- [ ] **Step 8: 提交**

```bash
git add tests/ docs/ AGENTS.md
git commit -m "docs: 太阳方向光与天空盒的架构口径与实测数据（v1.58）+ 既有 spec 观测口径隔离"
```
