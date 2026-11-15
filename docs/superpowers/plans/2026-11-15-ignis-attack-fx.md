# 焰魔攻击特效（地面火焰法阵 + 碎石圆环）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task（用户已指定 native inline 执行）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给焰魔举盾砸击/持盾冲撞补回原版的地面火焰法阵与碎石反馈，纯视觉、不改玩法。

**Architecture:** 新增 `render/flame-sigil.js`（additive InstancedMesh 贴地 quad 池，照 `fireball-renderer.js` 手法）；碎石复用既有 `block-hit-fx.js` 碎块池，只加一个纯函数 + 一个薄方法。触发点新增瞬态字段 `attackFxRequest`，在命中帧**不受 `freshLos` 复查影响**（既有招式中止门不动）。

**Tech Stack:** three r185.1 WebGPU（本地 vendor，import map）、原生 ES module、Playwright（channel: chromium）、浏览器内单测 runner。

**Spec:** `docs/superpowers/specs/2026-11-15-ignis-attack-fx-design.md`

## Global Constraints

- 资源 URL 一律 `resourceUrl()`（`src/core/resource-url.js`），禁止 `'/assets/`、`'/src/`、`'/vendor/`。
- 时间基准 `performance.now()`，**禁止 `Date.now()`**。
- 每帧零分配：临时矩阵/向量/四元数用模块级常量。
- 池零活跃时必须 `mesh.visible = false`（否则恒增 draw call + 进透明排序列表）。
- `render/` 可 import three；`entities/` **不得** import three、不得 import DOM。
- 新 `src/tests/test-*.js` 必须同时注册进 `src/tests/index.html`（漏注册 = 静默不跑）。
- Tier 4 像素判据必须**同时钉上下界**，且带对照组校准。
- 本轮**不改相机**（`player.js` 的 `camera.position.set` / `rotateX` / `rotateZ` 一行不动）。
- 本轮**不改**任何招式数值（`IGNIS_ATTACKS` 的射程/锥角/命中帧/时长/权重）。
- 本轮**不改**既有招式中止门（`ignis-boss-agent.js:326-332`）。
- 冻结常量：法阵 `radius 2.0`、基准几何 `PlaneGeometry(2,2)`（⇒ 实际 4×4 格）、`lifeMs 3000`、
  `segments 4`、`spacing 4.25`、`firstOffset 2`、`spinDegPerSec 20`、`maxActive 16`、`yLift 0.02`、
  延迟 `floor(1.5*l)*50` ms ⇒ `0,50,150,200`；
  碎石 `count 28`、`radius 1.3`、`forward 2.75`、`lateral -0.1`、`lift 0.3`、
  `size [0.14,0.24]`、`speed [1.2,2.6]`、`spin [4,10]`；
  地面扫描 `maxY = 脚底y+4`、`minY = 脚底y-8`。
- 素材 sha256（已入库）：`adc9d07f88cf031c9cacb1917a92cb8f34020dd68d6c4523eeae6b18d33a26e6`，3114 字节。

## Review Focus

1. **法阵落在方块内部或悬空**（前方地形凸起/未加载列）→ 期望贴凸起地表顶面，未加载则整段不生成，绝不落到 y=0 或世界底。
2. **法阵尺寸差一倍**（`PlaneGeometry(1,1)` vs `(2,2)`）→ 期望实际 4×4 格；单测钉几何边长，Tier 4 钉像素占比区间。
3. **碎石圆心错**（以脚底为圆心 vs 前移后的环心）→ 期望全部落在「前移 2.75 的环心」半径 1.3 的圆上。
4. **特效被 LOS 复查吞掉**（玩家侧移出锥/隔墙）→ 期望 `freshLos` 失败时特效仍播；但整招被中止时不播。
5. **零活跃仍占 draw call / 破水面顺序**→ 期望 `visible=false`，`water-order.spec` 全周顺序不变。

---

### Task 1: 法阵纯函数 + 渲染器（`flame-sigil.js`）

**Files:**
- Create: `src/render/flame-sigil.js`
- Create: `src/tests/test-flame-sigil.js`
- Modify: `src/tests/index.html`（加 import）
- 素材已入库：`assets/ignis/flame_sigil.png`（无需再拷）

**Interfaces:**
- Consumes: `resourceUrl` from `../core/resource-url.js`；three。
- Produces:
  - `FLAME_SIGIL`（冻结常量对象，字段见 Global Constraints）
  - `sigilSpawnPoints(at: number[3], yaw: number, cfg?) -> Array<{x:number, z:number, delayMs:number}>`
  - `sigilDelayMs(segmentIndex: number) -> number`
  - `sigilRotationRad(ageMs: number, cfg?) -> number`
  - `sigilOpacityAt(ageMs: number, delayMs: number, cfg?) -> {opacity:number, visible:boolean, done:boolean}`
  - `loadFlameSigilTexture() -> Promise<THREE.Texture>`
  - `class FlameSigilRenderer { constructor({scene, texture, maxActive?}); spawn(points: Array<{x,y,z,delayMs}>, nowMs); update(nowMs); dispose(); get mesh(); get activeCount() }`

⚠️ `spawn` 收**已算好 y 的点数组**（渲染层不查体素，与 `block-hit-fx` 同口径）。y 由 Task 3 的 `game.js` 算。

- [ ] **Step 1: 写失败测试** `src/tests/test-flame-sigil.js`

用 `test` from `./runner.js` + `assertEqual/assertTrue/assertFalse` from `./assert.js`；确定性 LCG 照 `test-block-hit-fx.js` 的 `makeRand`。断言：

```js
// ① 4 段距离 = 4.25*(l+2)，方向沿本仓 yaw 正前方 (−sin yaw, −cos yaw)
const pts = sigilSpawnPoints([10, 5, 20], 0);
assertEqual(pts.length, 4);
for (let l = 0; l < 4; l++) {
  const d = 4.25 * (l + 2);
  assertClose(pts[l].x, 10 + -Math.sin(0) * d, 1e-9);
  assertClose(pts[l].z, 20 + -Math.cos(0) * d, 1e-9);   // yaw=0 ⇒ 正前方是 −Z
}
// yaw=π/2 ⇒ 正前方是 −X
const p2 = sigilSpawnPoints([0, 0, 0], Math.PI / 2);
assertClose(p2[0].x, -8.5, 1e-9);
assertClose(p2[0].z, 0, 1e-9);

// ② 延迟取原版截断序列（不是线性 l*75）
assertEqual([0,1,2,3].map(sigilDelayMs), [0, 50, 150, 200]);

// ③ 延迟期内不可见；延迟后满亮；寿命末 done
assertFalse(sigilOpacityAt(100, 150).visible);
assertTrue(sigilOpacityAt(150, 150).visible);
assertEqual(sigilOpacityAt(150, 150).opacity, 1);
assertTrue(sigilOpacityAt(3000 + 150, 150).done);

// ④ 旋转单调增，20°/s
assertTrue(sigilRotationRad(1000) > sigilRotationRad(500));
assertClose(sigilRotationRad(1000), 20 * Math.PI / 180, 1e-9);
```

渲染器测试（three 真实构造，照 `test-block-hit-fx.js` 的 renderer 用例风格）：
```js
// ⑤ 基准几何边长必须是 2（⇒ scale=radius 后 4×4 格）—— Review Focus #2
const r = new FlameSigilRenderer({ scene: new THREE.Scene(), texture: fakeTex });
assertEqual(r.mesh.geometry.parameters.width, 2);
assertEqual(r.mesh.geometry.parameters.height, 2);
// ⑥ 零活跃 visible=false —— Review Focus #5
assertFalse(r.mesh.visible);
r.spawn([{ x: 0, y: 5, z: 0, delayMs: 0 }], 1000);
assertTrue(r.mesh.visible);
r.update(1000 + 3000 + 1);
assertFalse(r.mesh.visible);
assertEqual(r.activeCount, 0);
```
`fakeTex` 用 `new THREE.DataTexture(new Uint8Array(4), 1, 1)`（⚠️ 只为构造，不验 flipY）。

- [ ] **Step 2: 注册并跑，确认 RED**

在 `src/tests/index.html` 加 `import './test-flame-sigil.js';`（紧邻其它 import）。
Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `Failed to resolve module specifier` 或 `sigilSpawnPoints is not a function`。

- [ ] **Step 3: 实现 `src/render/flame-sigil.js`**

常量按 Global Constraints 冻结（用 `Object.freeze`）。纯函数按上面签名。
- `sigilSpawnPoints`：`fx = -Math.sin(yaw)`, `fz = -Math.cos(yaw)`；`d = spacing*(l+firstOffset)`。
- `sigilDelayMs(l)` = `Math.floor(1.5 * l) * 50`。
- `sigilOpacityAt`：`age < delay` ⇒ `{opacity:0, visible:false, done:false}`；
  `age >= delay + lifeMs` ⇒ `{opacity:0, visible:false, done:true}`；
  否则 `t = (age-delay)/lifeMs`，末 25% 线性淡出：`opacity = t < 0.75 ? 1 : (1-t)/0.25`。
- `loadFlameSigilTexture()`：`new THREE.TextureLoader().loadAsync(resourceUrl('assets/ignis/flame_sigil.png'))`，
  设 `colorSpace = THREE.SRGBColorSpace`、`magFilter/minFilter = THREE.NearestFilter`（像素风）。
- `FlameSigilRenderer`：`PlaneGeometry(2,2)` → `geometry.rotateX(-Math.PI/2)`（变水平，法线朝 +Y）；
  材质 `MeshBasicMaterial({map, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide, toneMapped:false})`；
  `InstancedMesh(geo, mat, maxActive)`，`frustumCulled=false`、`visible=false`、`name='ignis:flame-sigil'`，
  初始全 slot 零 scale。`spawn` FIFO 覆盖最旧（照 `explosion-renderer.burst`）。
  `update` 每帧写矩阵：`makeScale(radius)` → `makeRotationY(rot)` 复合 → `setPosition(x, y+yLift, z)`；
  ⚠️ **`makeScale` 会清位移，必须最后 `setPosition`**（`explosion-renderer.js` 记过这个坑）。
  opacity 取活跃段最大值写 `material.opacity`（照 `explosion-renderer`）；全部结束 ⇒ `visible=false`。
  `dispose` 移除 mesh + `geometry.dispose()` + `material.dispose()`。

- [ ] **Step 4: 跑，确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS，且新用例出现在 `window.__MC_TEST_RESULTS__` 的 suites 里。

- [ ] **Step 5: 提交**

```bash
git add src/render/flame-sigil.js src/tests/test-flame-sigil.js src/tests/index.html assets/ignis/flame_sigil.png
git commit -m "feat: 焰魔地面火焰法阵渲染器与纯函数"
```

---

### Task 2: 碎石圆环（复用 `block-hit-fx.js` 碎块池）

**Files:**
- Modify: `src/render/block-hit-fx.js`（新增常量 + 纯函数 + 方法，**不改既有字段**）
- Modify: `src/tests/test-block-hit-fx.js`（追加用例）

**Interfaces:**
- Consumes: 既有 `createDebrisSeeds` / `_spawnDebris(origin, normal, profile, color, rand, count, nowMs, dust)` / `IMPACT_FX.debris.maxActive`。
- Produces:
  - `IGNIS_SMASH_DEBRIS`（冻结，字段见 Global Constraints）
  - `smashDebrisRing(at: number[3], yaw: number, cfg?, rand?) -> Array<{position:number[3], normal:number[3]}>`
  - `BlockHitFxRenderer#spawnSmashRing(at, yaw, colorRgb, nowMs, {rand?, cfg?}) -> void`

- [ ] **Step 1: 写失败测试**（追加到 `src/tests/test-block-hit-fx.js` 末尾，import 补上新符号）

```js
// ① 28 块，全部在「前移 forward 后的环心」半径 radius 的圆上 —— Review Focus #3
const at = [10, 5, 20], yaw = 0;
const pts = smashDebrisRing(at, yaw, IGNIS_SMASH_DEBRIS, makeRand(7));
assertEqual(pts.length, 28);
const cx = at[0] + -Math.sin(yaw) * 2.75;
const cz = at[2] + -Math.cos(yaw) * 2.75;
for (const p of pts) {
  const r = Math.hypot(p.position[0] - cx, p.position[2] - cz);
  assertClose(r, 1.3, 1e-9);                      // 环心是前移后的，不是脚底
  assertClose(p.position[1], at[1] + 0.3, 1e-9);  // lift
  assertEqual(p.normal, [0, 1, 0]);
}
// 负向锚点：以脚底为圆心算 r 会得到 ≈2.75±1.3，这条必 FAIL
// ② 池容量安全（与焰魔死亡爆散并发不互相覆盖）
assertTrue(IGNIS_SMASH_DEBRIS.count + IGNIS_DEATH_BURST.count <= IMPACT_FX.debris.maxActive);
// ③ 方法真的入池且可见
const fx = new BlockHitFxRenderer({ scene: new THREE.Scene() });
fx.spawnSmashRing(at, yaw, [0.5, 0.5, 0.5], 1000, { rand: makeRand(3) });
assertEqual(fx.activeDebrisCount, 28);
assertTrue(fx.debrisMesh.visible);
```

- [ ] **Step 2: 跑，确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `smashDebrisRing is not a function`（import 解析失败）。

- [ ] **Step 3: 实现**

`IGNIS_SMASH_DEBRIS` 用既有 `freezeDeep`。
`smashDebrisRing`：环心 = `at + (−sin yaw, 0, −cos yaw)*forward + (cos yaw, 0, −sin yaw)*lateral`
（侧向 = 正前方向绕 Y 转 90°；yaw=0 时侧向 = `(1,0,0)`，与原版 `f=cos(yBodyRot)` 同位）；
逐 `i` 取 `angle = yaw + i`，`position = 环心 + (−radius*sin angle, lift, radius*cos angle)`。
`spawnSmashRing`：入参校验照 `spawnDeathBurst`（非有限值直接 return，防 NaN 污染实例矩阵）；
逐点调 `this._spawnDebris(p.position, p.normal, profile, color, rand, 1, nowMs, false)`，
`profile` 由 `IGNIS_SMASH_DEBRIS` 的 `size/speed/spin` 派生（形状对齐 `IMPACT_PROFILES` 碎块项）。
⚠️ **不改 `IMPACT_FX.debris.maxActive`、不新建池**。

- [ ] **Step 4: 跑，确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/render/block-hit-fx.js src/tests/test-block-hit-fx.js
git commit -m "feat: 焰魔砸击碎石圆环复用碎块池"
```

---

### Task 3: 触发点（Agent 瞬态字段）+ 装配接线

**Files:**
- Modify: `src/entities/bosses/ignis-boss-agent.js`（命中帧内产 `attackFxRequest`；返回值带上）
- Modify: `src/entities/ignis/ignis-system.js`（`createState` 增字段）
- Modify: `src/core/game.js`（纹理加载 / 装配 / update / dispose / `_consumeIgnisFxRequests`）
- Modify: `src/tests/test-ignis-boss-agent.js`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `FlameSigilRenderer` / `sigilSpawnPoints` / `loadFlameSigilTexture`；
  Task 2 的 `spawnSmashRing` / `IGNIS_SMASH_DEBRIS`。
- Produces: `state.attackFxRequest: {at:number[3], yaw:number, kind:string} | null`（瞬态，不进 snapshot）。

- [ ] **Step 1: 写失败测试**（追加到 `src/tests/test-ignis-boss-agent.js`）

用该文件既有的 `groundWorld` / `makeWorld` / 推进 helper（**复用，不自写矩阵链或新 helper**）。
```js
// ① freshLos 失败但招式未被中止 ⇒ FX 仍产生，伤害请求不产生 —— Review Focus #4
//    构造：losVisible 缓存为 true（招式不中止），但命中帧那一刻玩家被墙挡（_queryLos 返 false）
//    断言：推进到命中帧后 state.attackFxRequest !== null 且 state.attackRequest === null
// ② 招式被中止（缓存 losVisible=false）⇒ 两者都 null（防止误改中止门）
// ③ 非 shieldBash/shieldSmash 招（swing/spin）也产 FX 请求（过滤在 game.js 侧，Agent 不分支）
```
⚠️ 具体 fixture 用该 spec 已有的「墙世界」`wallWorld({groundY,wallZ,halfLen,wallH})`，
不要新造世界函数。断言前先打印实际值确认 fixture 真的构造出了目标条件。

- [ ] **Step 2: 跑，确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `attackFxRequest` 为 `undefined`。

- [ ] **Step 3: 实现三处**

**Agent**：在 `let attackRequest = null;`（`:240`）旁加 `let attackFxRequest = null;`；
命中帧 `if (prevAnimT < profile.hitFrameSeconds && attackAnimT >= profile.hitFrameSeconds)` 内、
**`if (freshLos)` 之外**写 `attackFxRequest = { at: [px, py, pz], yaw, kind: attackKind };`；
返回对象加 `attackFxRequest`。⚠️ 中止门 `:326-332` 一行不改。

**system**：`createState` 参数解构加 `attackFxRequest`，返回对象加
`attackFxRequest: attackFxRequest || null`（注释说明瞬态、不入 snapshot，同 `attackRequest`）。

**game.js**：
- 纹理：在 `_explosionSpriteTexture` 之后加 `this._flameSigilTexture = await loadFlameSigilTexture().catch(...)`（warn + null，不阻断启动）。
- 装配：`blockHitFx` 之后 `this.flameSigil = new FlameSigilRenderer({scene: this.scene, texture: this._flameSigilTexture})`；texture 为 null 时**跳过装配**（`this.flameSigil = null`）。
- update：`this.blockHitFx.update(nowMs)` 之后加 `this.flameSigil?.update(nowMs)`。
- dispose：`this.blockHitFx?.dispose()` 附近加 `this.flameSigil?.dispose()`。
- 帧循环：`this._consumeGuardianAttackRequests()` 之后加 `this._consumeIgnisFxRequests()`。
- 新方法 `_consumeIgnisFxRequests()`：零分配门控 `if (!this.ignises || this.entities.count(IGNIS_TYPE) === 0) return;`
  逐实体读 `state.attackFxRequest`；`kind === 'shieldSmash' || kind === 'shieldBash'` 才处理：
  · 碎石：环心 = `at + 正前方*2.75 + 侧向*(-0.1)`（复用 `smashDebrisRing` 内部同一公式 ⇒ **game.js 只算取色用的脚下格**，
    不重算落点）；取色格 = `floor(环心x), floor(at.y)-1, floor(环心z)`，
    经 `this.registry.nameOf(this.world.getBlockId(...))` + `blockHitFx.colorResolver` 得 rgb，
    缺色退中性灰；调 `this.blockHitFx.spawnSmashRing(req.at, req.yaw, rgb, nowMs)`。
  · 法阵（仅 `shieldBash`）：`sigilSpawnPoints(req.at, req.yaw)` 逐点算地面 y
    （从 `floor(at.y)+4` 向下扫到 `floor(at.y)-8`，取第一个 `isSolid(x,y,z) && !isSolid(x,y+1,z)` 的 `y+1`；
    扫不到则**跳过该段**），非空则 `this.flameSigil.spawn(points, nowMs)`。
  ⚠️ `nowMs` 用帧循环已有的 `performance.now()` 值（不新取，避免同帧两个时基）。

- [ ] **Step 4: 跑，确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/entities/bosses/ignis-boss-agent.js src/entities/ignis/ignis-system.js src/core/game.js src/tests/test-ignis-boss-agent.js
git commit -m "feat: 焰魔砸击特效触发点与装配接线"
```

---

### Task 4: 素材门禁 + Tier 4 像素实测 + 回归

**Files:**
- Modify: `tools/check-data.mjs`（法阵贴图存在 + sha256 断言）
- Create: `tests/ignis-fx.spec.mjs`

**Interfaces:**
- Consumes: `window.__MC_GAME__`（`game.flameSigil` / `game.blockHitFx` / `game.ignises`）。
- Produces: 无（终端产物）。

- [ ] **Step 1: 加素材门禁**

在 `tools/check-data.mjs` 的焰魔环节加：文件存在 + `sha256 === 'adc9d07f...'` + 字节数 3114。
Run: `npm run check:data`
Expected: PASS。

- [ ] **Step 2: 写 Tier 4 spec** `tests/ignis-fx.spec.mjs`

照 `tests/block-hit-fx.spec.mjs` 的启动/等待世界稳定手法（**等 sections 停止增长**，不只看队列归零）。
- 颜色判据：`r > g && r - b > 100`（金黄符文；沙漠沙 193,183,144 的 `r-b=49` 被排除）。
- 先测**同状态重复截图噪声底**，再断言法阵帧的金黄占比 ∈ `[噪声底+Δ, 上界]`（上界防「烧成白团」）。
- 碎石：`blockHitFx.activeDebrisCount > 0` + 截图与对照帧有差。
- draw call：零活跃时 `flameSigil.mesh.visible === false`。
- 像素回读在 `renderer.render()` **之后**、rAF 回调内。
- `channel: 'chromium'` 由 `playwright.config.mjs` 全局提供。

- [ ] **Step 3: 跑 Tier 4 + 水面顺序回归**

Run: `npx playwright test tests/ignis-fx.spec.mjs tests/water-order.spec.mjs`
Expected: PASS。⚠️ 命令**不接管道**（`| sed`/`| grep` 会把退出码变成末端工具的，造成假绿）。

- [ ] **Step 4: 全门禁**

Run: `npm run check`
Expected: PASS（arch + data + lint）。
不改热路径（mesher/materials/render-world/scheduler/physics 均未动）⇒ 按 testing-policy **不跑** `bench --check`。

- [ ] **Step 5: 提交**

```bash
git add tools/check-data.mjs tests/ignis-fx.spec.mjs
git commit -m "test: 焰魔特效像素实测与素材门禁"
```

---

## Self-Review

**1. Spec coverage**：§5.1 法阵 → Task 1；§5.2 碎石 → Task 2；§5.3/5.4 接线与触发 → Task 3；
§3.4 素材门禁 + §6 Tier 1/Tier 4/门禁 → Task 1/2/3 的测试步 + Task 4。§8「不做」项由 Global Constraints 钉住。无缺口。

**2. Step scan**：每步一个可检查动作。法阵 opacity 包络与碎石环心公式给了具体算法（签名+测试不能唯一确定），其余只给签名与冻结值。

**3. Type consistency**：`sigilSpawnPoints` 返回 `{x,z,delayMs}`（无 y），`FlameSigilRenderer.spawn` 收 `{x,y,z,delayMs}`（y 由 Task 3 补）—— 两者刻意不同，已在 Task 1 Interfaces 标注。`smashDebrisRing` / `spawnSmashRing` / `IGNIS_SMASH_DEBRIS` 三名在 Task 2/3 一致。

**4. Review Focus**：5 条各有归属 —— #1→Task 3 Step 3 的地面扫描 + Task 1 测试；#2→Task 1 Step 1 断言⑤ + Task 4 像素区间；#3→Task 2 Step 1 断言①；#4→Task 3 Step 1 断言①②；#5→Task 1 Step 1 断言⑥ + Task 4 water-order。

**5. Proportion**：4 个任务，代码块仅测试断言与两处算法，短于 spec。