# 太阳阴影（shadow map）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 太阳方向光把地形/树/建筑的影子投到地面与方块表面（shadow map 实时投影），视觉对齐 mc-lite，性能不破坏 M3 冻结基线。

**Architecture:** 复用现有 `weaponSun` 方向光开 `castShadow`（WebGPU per-light 按需刷新），opaque/cutout 两个 BatchedMesh 通道投射，三通道 unlit 体素材质在 colorNode 里乘 TSL `shadow()` 节点接收；刷新由 `ShadowScheduler`（200ms 节流纯函数）编排，触发源 = 世界编辑（`block-changed` 订阅）+ 玩家移动（5 格阈值）+ 日夜方向变化；阴影浓度 uniform 随日夜 `skyDim` 淡出。

**Tech Stack:** 纯 JavaScript ES2022 + JSDoc（禁 TypeScript、无 bundler）、three r185.1 WebGPU + TSL（本地 `vendor/three/`）、浏览器内单测（`src/tests/`）+ Playwright E2E / Tier 4 像素实测（`tests/`）。

**Spec:** `docs/superpowers/specs/2026-10-13-sun-shadow-map-design.md`

## Global Constraints

- **纯 JavaScript（ES2022+ ESM）+ JSDoc，禁止 TypeScript，无编译/转译、无 bundler。**
- **红线 1 数据只有一份权威**：太阳方向数据的唯一权威 = `daynight.js` 的 `VISUAL_STYLES.sunDirection`（mc-lite 原值）；game.js 只消费，不另存一份默认方向。
- **红线 3/9**：阴影 pass 是渲染层叠加，不改 GEN/MESH Worker 管线；WebGPU 唯一后端，不做 WebGL 降级。
- **节流口径是 per-light**（`light.shadow.autoUpdate/needsUpdate`，`ShadowNode.updateBefore` 判定），不是 mc-lite WebGL 的 `renderer.shadowMap.autoUpdate` —— 后者在 WebGPU 后端不生效（spec DR-5）。
- **`renderer.shadowMap.enabled = true` 是硬门控**（否则 `castShadow` 被忽略，`three.webgpu.js:43563`）。
- **材质构建须先有 sunLight**：`createVoxelMaterials(atlasTexture, sunLight)` 在 `RenderWorld` 构造时被调（`render-world.js:41`），game.js 里灯光必须先于 `new RenderWorld` 创建。
- **mc-lite 参数照抄**：mapSize 256 / 阴影相机 ±30 / near 0.1 / far 250 / bias 0.00008 / normalBias 0.048 / radius 2.6 / 光源偏移 60 / 移动阈值 distSq>25 / 节流 200ms。
- **太阳方向三组值**（mc-lite `Engine.js:74/99/122`，风格对应按 fogColor 比对确认）：morning `[0.18,0.45,0.88]` / noon `[0,0.8,0.6]` / night `[0.08,0.25,0.96]`。
- **门禁分层**：materials/render 是热路径 → `npm run check` + 单测 + E2E + `npm run bench -- --check`。
- **Tier 4 断言阈值先实测再写**（CLAUDE.md「写断言前必须先在真实数据上跑一次、打印实际值」），不贴线（留一个量子以上余量）。
- **每个 Task 结束必须 commit**（Conventional Commits）；**未获用户明确指令不得 push**。
- `daynight.js` 保持无 three 依赖（文件头既有口径），方向用普通数组 + 手工归一化。

## Review Focus

1. **WebGPU 阴影 pass × BatchedMesh 兼容性**（最大未知数）：自定义 `packed` 属性布局 + per-instance 剔除的 BatchedMesh 走阴影 pass 可能渲染异常/报错 → Task 3 是最小接线实测闸门，不通即停（spec §8）。
2. **阴影滞后/不更新**：放块后影子不跟着变（订阅漏接）、走远后影子停在原地（移动阈值漏接）→ Task 4 的 E2E 钉「放块后 needsUpdate 被置起」+ 像素实测。
3. **开关关闭后的残留**：`setShadowsEnabled(false)` 后若 `uShadowStrength` 不归零，旧阴影贴图仍被采样 → 画面出现冻结残影 → Task 5 像素实测「开关前后地面亮度无差异」。
4. **夜里阴影过黑**：`uShadowStrength` 未随 `skyDim` 淡出时，夜里 25% 照度上再叠全浓度阴影 → 死黑 → Task 4 单测钉 `uShadowStrength === skyDim`。
5. **枪模型被阴影影响**：视图模型挂相机上，若吃了阴影会随转头闪烁 → 保持 `castShadow=false`；PBR 接收阴影是 mc-lite 同口径（可接受）→ Task 3 前提断言。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/render/shadow-manager.js` | 新建 | `ShadowScheduler`：200ms 节流 + pending 补刷的纯逻辑（无 DOM/three） |
| `src/render/daynight.js` | 改 | `VISUAL_STYLES` 加 `sunDirection`；`lerpParams` 插值方向；`DayNight` 写 `uShadowStrength` + `onSunDirection` 回调 |
| `src/render/materials.js` | 改 | `createVoxelMaterials(atlasTexture, sunLight)`；colorNode 乘 `mix(1, shadow(sunLight), uShadowStrength)`；返回 `uShadowStrength` 句柄 |
| `src/render/render-world.js` | 改 | 构造参数透传 `sunLight`；opaque/cutout `castShadow=true`、三通道 `receiveShadow=true` |
| `src/core/game.js` | 改 | `weaponSun`→`sunLight` 配置阴影相机；`shadowMap.enabled/type`；`ShadowScheduler` 接线（编辑订阅 + 移动阈值 + 日夜回调）；`setShadowsEnabled`；帧循环 tick |
| `src/tests/test-shadow-manager.js` | 新建 | ShadowScheduler 节流语义单测（注册进 `index.html`） |
| `src/tests/test-daynight.js` | 改 | sunDirection 数值/连续性/单位长度 + uShadowStrength 联调用例 |
| `tests/sun-shadow.spec.mjs` | 新建 | E2E 接线断言 + Tier 4 像素实测（有影/开关/夜淡/编辑更新） |
| `docs/phase-1-engine-design.md` | 改 | §4.4.4 修订（v1.43→v1.44）+ 修订说明 |
| `CLAUDE.md`（= AGENTS.md） | 改 | 活跃约束段追加阴影口径 |
| `docs/roadmap.md` | 改 | 独立改动表加 v1.44 行 + 一句话现状 |

---

### Task 1: ShadowScheduler 节流纯函数（TDD）

**Files:**
- Create: `src/render/shadow-manager.js`
- Create: `src/tests/test-shadow-manager.js`（并注册进 `src/tests/index.html`）

**Interfaces:**
- Produces: `class ShadowScheduler`，构造 `{minIntervalMs?: number}`（默认 200）；
  `request()`（挂起一次刷新请求，无时钟参数）；
  `tick(nowMs: number): boolean`（本帧是否应真正刷新：pending 且距上次刷新 ≥ minIntervalMs 时返回 true 并清 pending、记录时刻；否则 false）。

- [ ] **Step 1: 注册测试文件 + 写失败测试**

`src/tests/index.html` 在 `import './test-progress.js';` 后加 `import './test-shadow-manager.js';`（`check:data` [测试注册] 门禁强制）。

`test-shadow-manager.js` 用例（`runner.js` 的 `test` + `assert.js` 断言，照 `test-daynight.js` 风格）：
1. 「首次 request 后 tick 立即刷新」：`request(); tick(1000) === true`
2. 「200ms 内的重复请求被节流」：`tick(1000)` 后 `request(); tick(1100) === false`
3. 「节流期内的请求不丢（pending 补刷）」：接上条 `tick(1250) === true`（距 1000 已 250 ≥ 200）
4. 「无请求时 tick 恒 false」：新实例 `tick(5000) === false`；且刷新后无新请求 `tick(9999) === false`
5. 「minIntervalMs 可配」：`new ShadowScheduler({minIntervalMs: 50})` → `request(); tick(0)===true; request(); tick(49)===false; tick(50)===true`

- [ ] **Step 2: 跑测试验证 RED**

Run: `npm start` 起服务 + Playwright 跑 `tests/harness.spec.mjs`（浏览器内单测唯一入口），过滤看 shadow-manager 用例
Expected: 5 条 FAIL（模块不存在 / import 报错）；`npm run check:data` 的 [测试注册] 通过（文件已建 + 已注册）

- [ ] **Step 3: 实现 `ShadowScheduler`**

约 20 行：`_lastFlushAt = -Infinity`、`_pending = false`；`request()` 置 pending；`tick(nowMs)` 按上述语义判定。JSDoc 注明「mc-lite `World.requestShadowMapUpdate` 200ms 节流同构；WebGPU 后端消费侧置 `light.shadow.needsUpdate`」。

- [ ] **Step 4: 跑测试验证 GREEN**

Expected: 5 条全绿，全量单测无回归（计数以 harness 输出为准）

- [ ] **Step 5: Commit**

```bash
git add src/render/shadow-manager.js src/tests/test-shadow-manager.js src/tests/index.html
git commit -m "feat(render): ShadowScheduler 阴影刷新节流纯函数（200ms + pending 补刷）"
```

---

### Task 2: daynight 太阳方向 + uShadowStrength 字段（TDD）

**Files:**
- Modify: `src/render/daynight.js`
- Test: `src/tests/test-daynight.js`

**Interfaces:**
- Consumes: 无
- Produces: `VISUAL_STYLES.*.sunDirection: [x,y,z]`（三组 mc-lite 原值）；`paramsAtHour(h).sunDirection`（插值后**已归一化**的 `[x,y,z]`）；`DayNight` 构造选项新增 `voxelUniforms.uShadowStrength`（与 uSkyDim 同对象）与 `onSunDirection?: (dir: [x,y,z]) => void` 回调；`_apply(p)` 写 `uShadowStrength.value = p.skyDim` 并调 `onSunDirection(p.sunDirection)`

- [ ] **Step 1: 写失败测试**

`test-daynight.js` 新增用例：
1. 「三风格 sunDirection 是 mc-lite 原值」：逐组 `assertEqual` 三个分量（morning `[0.18,0.45,0.88]` / noon `[0,0.8,0.6]` / night `[0.08,0.25,0.96]`）
2. 「paramsAtHour 的方向是单位向量」：抽样 h=0/3/7/12/18/23，`|len-1| < 1e-6`
3. 「方向在风格边界连续」：相邻 0.25h 的方向分量差 < 0.05（照既有 skyDim 平滑用例手法；noon→morning 边界 9h、morning→night 边界 19h 附近加密抽样）
4. 「正午方向 = noon 原值归一化」：`paramsAtHour(12).sunDirection` == normalize(`[0,0.8,0.6]`)
5. 「uShadowStrength 随 skyDim」：构造 DayNight（stub scene/fog/voxelUniforms，`{uSkyDim,uBlockBoost,uShadowStrength}` 各 `{value:0}`），`setTime(12)` 后 `uShadowStrength.value === 1`；`setTime(0)` 后 `=== 0.25`
6. 「onSunDirection 回调收到归一化方向」：spy 记录，`setTime(12)` 后最后一次入参 == noon 归一化方向

- [ ] **Step 2: 跑测试验证 RED**

Expected: 6 条新用例 FAIL（`sunDirection` undefined 等），既有 daynight 用例仍绿

- [ ] **Step 3: 实现**

`VISUAL_STYLES` 三项各加 `sunDirection`；`lerpParams` 加方向逐分量 lerp；`paramsAtHour` 返回前归一化（手工 `Math.sqrt`，保持无 three）；`_apply` 加两行（uShadowStrength + onSunDirection，回调可空）。`setStyle` 路径自动生效（走 `_apply`）。

- [ ] **Step 4: 跑测试验证 GREEN**

Expected: 全绿（新 6 条 + 既有 daynight 用例无回归）

- [ ] **Step 5: Commit**

```bash
git add src/render/daynight.js src/tests/test-daynight.js
git commit -m "feat(render): 日夜风格加太阳方向（mc-lite 三组原值插值）+ uShadowStrength 联动"
```

---

### Task 3: 最小阴影接线（风险闸门：WebGPU × BatchedMesh 实测）

**Files:**
- Modify: `src/render/materials.js`（`createVoxelMaterials` 签名 + colorNode）
- Modify: `src/render/render-world.js`（透传 sunLight + cast/receive）
- Modify: `src/core/game.js`（sunLight 阴影相机配置 + shadowMap 开关）
- Test: `tests/sun-shadow.spec.mjs`（先写接线断言 + 像素 RED）

**Interfaces:**
- Consumes: 无（本任务不接调度，`needsUpdate` 常驻 true 或 autoUpdate 临时 true 供实测）
- Produces: `createVoxelMaterials(atlasTexture, sunLight)` 返回 `dayNight: {uSkyDim, uBlockBoost, uShadowStrength}`；`game.sunLight`（供 E2E 与后续任务）；`RenderWorld` 构造参数加 `sunLight`

⚠️ **本任务是 spec §8 的风险闸门**：若像素实测证明阴影不出现（BatchedMesh/packed 属性不兼容），**停下来报告**，不要自行改道（回退选项在 spec §8，须用户决策）。

- [ ] **Step 1: 写 E2E（接线断言 + 像素 RED）**

`tests/sun-shadow.spec.mjs`，参照 `tests/tnt.spec.mjs` 的游戏页驱动模式（`/?seed=12345&vd=4` + `window.__MC_GAME__`）：

用例 1「接线」：`renderer.shadowMap.enabled === true`、`shadowMap.type === THREE.PCFSoftShadowMap` 值、`sunLight.castShadow === true`、`sunLight.shadow.mapSize` 256×256、阴影相机 ±30/0.1/250、bias 三值、`renderWorld.meshes.opaque.castShadow === true`、cutout 同、transparent `=== false`、三通道 `receiveShadow === true`、**`viewWeapon` 的枪模型 `castShadow === false`**（Review Focus 5：视图模型不投影）。

用例 2「Tier 4 有影」：固定 noon 风格（`game.setVisualStyle('noon')`）→ 在玩家前方平地用 `game.editor`（或 world API）**实测找一个可靠落点**放 3 格高 stone 柱 → 等 remesh 收敛 → 相机对准柱子 → 截图 → 柱影区（沿光方向 `(0,-0.8,-0.6)` 的水平投影侧 = 柱的 **-Z 侧**）亮度 < 同距离开阔区亮度。
⚠️ **先跑打印实测值再定阈值**（CLAUDE.md 口径）：先写「只打印两区亮度」的探针跑一遍，确认差异量级后再写断言（差异须留 >20% 余量，不贴线）。

- [ ] **Step 2: 跑 E2E 验证 RED**

Expected: 用例 1 FAIL（shadowMap.enabled false 等）、用例 2 FAIL（无影，两区亮度相等）

- [ ] **Step 3: 接线实现**

`game.js`（构造段，`weaponSun` 处）：改名 `this.sunLight`，按 Global Constraints 的 mc-lite 参数配置 `shadow.*`，`this.scene.add(sunLight.target)`；`this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;`。本任务临时 `sunLight.shadow.autoUpdate = true`（Task 4 才切按需刷新，降低本步变量数）。⚠️ 灯光创建保持在 `new RenderWorld` 之前（既有顺序已满足）。

`render-world.js`：构造参数加 `sunLight`，传给 `createVoxelMaterials(atlasTexture, sunLight)`；三通道建好后：`meshes.opaque.castShadow = meshes.cutout.castShadow = true`、三通道 `receiveShadow = true`。

`materials.js`：import 加 `shadow, mix`（`three/tsl`）；`createVoxelMaterials(atlasTexture, sunLight)`；`const uShadowStrength = uniform(1.0);` `const shadowFactor = mix(float(1), shadow(sunLight), uShadowStrength);`；`rgb` 的亮度项改 `mul(texColor.rgb, mul(vShade, shadowFactor))`（emissive 加项保持在阴影相乘之后）；返回 `dayNight` 加 `uShadowStrength`。

- [ ] **Step 4: 跑 E2E 验证 GREEN + 全量回归**

Expected: 用例 1/2 全绿；`tests/render-terrain.spec.mjs` / `tests/daynight-visual.spec.mjs` / `tests/ao-visual.spec.mjs` 等既有渲染 spec 无回归（材质改动的直接波及面）；`npm run check` 全绿

- [ ] **Step 5: Commit**

```bash
git add src/render/materials.js src/render/render-world.js src/core/game.js tests/sun-shadow.spec.mjs
git commit -m "feat(render): 太阳阴影最小接线——shadow map 投射 + 体素材质接收（WebGPU/TSL）"
```

---

### Task 4: 按需刷新接线（编辑 / 移动 / 日夜方向）

**Files:**
- Modify: `src/core/game.js`（调度接线 + 帧循环）
- Modify: `src/render/daynight.js`（DayNight 构造接 `onSunDirection`，仅 game.js 侧传参）
- Test: `tests/sun-shadow.spec.mjs`（加用例）

**Interfaces:**
- Consumes: Task 1 `ShadowScheduler`、Task 2 `onSunDirection` 回调、Task 3 `game.sunLight`
- Produces: `game.shadowScheduler`；帧循环语义：`tick(nowMs)===true` → `sunLight.shadow.needsUpdate = true`

- [ ] **Step 1: 写失败测试**

`sun-shadow.spec.mjs` 新增：
1. 「autoUpdate 已关、调度器在位」：`sunLight.shadow.autoUpdate === false`、`game.shadowScheduler` 存在
2. 「放块触发阴影刷新」：记录 `sunLight.shadow.needsUpdate`，经 `game.editor` 放一块 → 断言 needsUpdate 被置 true（或下一帧 tick 后阴影贴图 version 变化 —— 实施时选可直接观测的口径，先实测打印）
3. 「移动超 5 格触发光源重定位」：teleport 玩家 +6 格 → 一帧后 `sunLight.target.position` ≈ 新玩家位置（容差 0.1）

- [ ] **Step 2: 跑测试验证 RED**

Expected: 3 条 FAIL（autoUpdate 还是 true / 无订阅 / 无重定位）

- [ ] **Step 3: 实现接线**

`game.js`：
- `this.shadowScheduler = new ShadowScheduler()`；`sunLight.shadow.autoUpdate = false;`
- `this.editor.subscribe(() => this.shadowScheduler.request())`（block-changed 唯一入口，放/挖/TNT/炮塔全覆盖 —— 在 editor 创建后、`_waitForColumn` 前后均可，订阅无时序坑）
- `this._lastShadowPos = {x,y,z}`（玩家位置快照）；帧循环 `player.update` 后：`distSq > 25` → `_updateSunPosition()` + `request()` + 刷新 `_lastShadowPos`
- `_updateSunPosition()`：`sunLight.position = playerPos + sunDir×60`、`sunLight.target.position = playerPos`（`sunDir` 取 DayNight 当前方向，归一化数组）
- DayNight 构造传 `onSunDirection: (dir) => { this._sunDir = dir; if (this.player) { this._updateSunPosition(); this.shadowScheduler.request(); } }`
  ⚠️ **回调必须判 `this.player` 存在**：`DayNight` 构造（game.js:169）会**立即**触发一次
  `onSunDirection`，而 `this.player` 在 :441 才创建（`start()` 内）→ 不判空会在启动时抛错。
  首次定位由帧循环的移动阈值自然补上：`_lastShadowPos` 初始 `(0,0,0)`，出生点距它必 >5 格
  → 第一帧即 `_updateSunPosition()`（无需额外初始化调用）。
  ⚠️ `_sunDir` 初始值从 `paramsAtHour(12).sunDirection` 取（红线 1：不写字面量）
- 帧循环渲染前：`if (this.shadowScheduler.tick(nowMs)) this.sunLight.shadow.needsUpdate = true;`
- 启动：`start()` 世界就绪后 `sunLight.shadow.needsUpdate = true`（首次渲染）

- [ ] **Step 4: 跑测试验证 GREEN + 回归**

Expected: 全绿；Task 3 用例无回归；`tests/weapons-world-edit.spec.mjs`（编辑路径直接波及）通过

- [ ] **Step 5: Commit**

```bash
git add src/core/game.js src/render/daynight.js tests/sun-shadow.spec.mjs
git commit -m "feat(render): 阴影按需刷新——编辑订阅 + 移动 5 格阈值 + 日夜方向联动（200ms 节流）"
```

---

### Task 5: 开关 setShadowsEnabled（默认开）

**Files:**
- Modify: `src/core/game.js`
- Modify: `src/main.js`（`?shadows=0` URL 参数 → 构造选项，照 `?weather=` 既有调试入口模式）
- Test: `tests/sun-shadow.spec.mjs`

**Interfaces:**
- Consumes: Task 3 `uShadowStrength` 句柄（`renderWorld.materials.dayNight.uShadowStrength`）、Task 4 调度器
- Produces: `Game` 构造选项 `shadows = true`；`Game.setShadowsEnabled(enabled: boolean)`；`Game.shadowsEnabled` getter（E2E 断言用）

- [ ] **Step 1: 写失败测试**

`sun-shadow.spec.mjs` 新增：
1. 「默认开启」：`game.shadowsEnabled === true`
2. 「关闭后视觉无影（Tier 4）」：开/关两种状态各截图同一场景（ noon、同一相机位），柱影区与开阔区亮度差：开启 >20%、关闭 <5%（阈值先实测打印标定）
3. 「构造选项可关（URL 入口）」：`/?seed=12345&vd=4&shadows=0` 起页 → `game.shadowsEnabled === false` 且像素无影（复用用例 2 判据）
4. 「重新开启后阴影恢复」：关→开→`needsUpdate === true` 且像素差异恢复

- [ ] **Step 2: 跑测试验证 RED**

Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现**

`setShadowsEnabled(enabled)`：`sunLight.castShadow = enabled`；`uShadowStrength.value = enabled ? this.dayNight.params.skyDim : 0`；enabled 时 `shadow.needsUpdate = true`。构造选项 `shadows`（默认 true）：false 时 start 里调 `setShadowsEnabled(false)`。`main.js`：`params.get('shadows') === '0'` → `shadows: false` 传入构造。

- [ ] **Step 4: 跑测试验证 GREEN + 回归**

- [ ] **Step 5: Commit**

```bash
git add src/core/game.js src/main.js tests/sun-shadow.spec.mjs
git commit -m "feat(render): 阴影代码级开关 setShadowsEnabled（默认开，不进设置面板）"
```

---

### Task 6: 全量回归 + bench + 负向验证

**Files:** 无代码改动（验证任务）

- [ ] **Step 1: 全量 E2E**

Run: `npm test`
Expected: 全绿；若计时型 spec 贴线（m1-acceptance / weapons-world-edit / m3-rain 已知 flaky）→ 按 CLAUDE.md 做**交替对照**（MOD/BASE 交错各 2~3 轮），不单看数值

- [ ] **Step 2: bench 回归门禁**

Run: `npm run bench -- --check`
Expected: 无 >10% 回退。⚠️ 不带 `--check` 会重写冻结基线；若误跑须 `git checkout docs/m3-baseline.*`。若 frameP95 量子贴线阻断 → 交替对照判定

- [ ] **Step 3: 负向验证（注入后真 FAIL，逐条记录后还原）**

1. 去掉 `editor.subscribe` 接线 → 放块后 needsUpdate 不再被置起（Task 4 用例 2 FAIL）
2. `ShadowScheduler.tick` 去掉节流判定（恒 true）→ 移动中每帧刷新（实测帧时下降或 needsUpdate 每帧 true 的可观测口径 FAIL）
3. `materials.js` 去掉 `shadowFactor` 相乘 → Tier 4 无影（Task 3 用例 2 FAIL）
4. `uShadowStrength` 不随 skyDim（固定 1）→ 夜里阴影全浓度（Task 2 用例 5 FAIL）
每条注入确认 FAIL 后 `git checkout` 还原，清单记入验收报告

- [ ] **Step 4: 无 commit**（纯验证；结果进 Task 7 的验收记录）

---

### Task 7: 文档同步（设计文档 v1.44 / CLAUDE.md / roadmap）

**Files:**
- Modify: `docs/phase-1-engine-design.md`（首行版本 v1.43→v1.44 + 修订说明 + §4.4.4）
- Modify: `CLAUDE.md`（活跃约束段）
- Modify: `docs/roadmap.md`（独立改动表 v1.44 行 + 一句话现状 + 最后更新日期）

- [ ] **Step 1: 设计文档修订**

首行版本号 bump v1.44 + 修订说明一条（太阳阴影落地：§4.4.4 口径变更 + 与 DR-14 的关系）。§4.4.4 原文（2048 / 视距 60% / BlockRegistry 驱动）改为实测口径：mapSize 256 / ±30 / 通道级投射（opaque+cutout）/ 太阳方向随日夜插值 / per-light 按需刷新；注明 v1.9/DR-14（skylight 遮挡）与本决策是两条独立路线、DR-14 不推翻。

- [ ] **Step 2: CLAUDE.md 活跃约束**

追加（影响后续实现决策的口径）：① WebGPU 阴影节流是 per-light（`light.shadow.autoUpdate`），mc-lite 的 `renderer.shadowMap.autoUpdate` 写法在本后端不生效；② 阴影 pass 不消费 alphaTest（树冠投影实心轮廓，Minecraft 同款）；③ `createVoxelMaterials` 依赖 sunLight 先建（构造顺序）；④ 实体加阴影的预留接线点（InstancedMesh 开 castShadow + 材质乘 shadow 节点同手法）。

- [ ] **Step 3: roadmap 同步**

「M8/M9 之后的独立改动表」加 v1.44 行（一句话 + 关键 commit）；「一句话现状」段补太阳阴影已落地；最后更新日期。⚠️ 计数类数字一律不硬编码（以 `check:data` / harness 输出为准）。

- [ ] **Step 4: `npm run check` 全绿后 Commit**

```bash
git add docs/phase-1-engine-design.md CLAUDE.md docs/roadmap.md
git commit -m "docs: 太阳阴影落地——设计文档 v1.44（§4.4.4 口径变更）+ 活跃约束 + roadmap"
```

---

## 验收汇总（全部 Task 完成后向用户报告）

- 实测数据：bench 前后 fps/p95/draw 对照、Tier 4 亮度差实测值、负向验证清单
- 偏离表：spec §9 五条有意偏离 mc-lite 的落地确认
- 遗留：实体阴影预留（未实现）、树叶实心投影观感待用户实玩确认
