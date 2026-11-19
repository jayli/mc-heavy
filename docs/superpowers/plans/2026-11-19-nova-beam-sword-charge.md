> ⚠️ **本文档已作废（2026-11-19）。** 用户实玩后改选型：「干脆改成 storm lance 算了，
> 这个是最简单的特效。你不要参照 nova bean 了。」现行设计见
> `2026-11-19-storm-lance-sword-charge-design.md`。**保留本文仅为留存实测结论**
> （WebGPU 无 ShaderMaterial / bloom 0.03 / toneMapped 不存在 / 爆炸伤害只打丧尸等），
> 其中的六 pass 架构与玩法数值**一律不再实施**。

# 持剑蓄力大招 Nova Beam 实施计划（v3.20）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（本会话内实施）。
> 步骤用 `- [ ]` 复选框跟踪。

**Goal:** 持剑长按左键 2 秒蓄满、松开发射一道 26 格 Nova Beam 光柱，扫到的每个丧尸/Boss 各扣
50（= 一颗炸弹），不破坏方块；视觉逐层复刻上游六个 pass。

**Architecture:** 玩法侧纯函数 + 状态机（`player/weapons/`，无 three）→ 命中经装配层注入的
`sweepBeam`（五射线十字截面，复用 `definition.raycastAabb` 唯一权威）→ `damageEntity` 按类型分发。
渲染侧把上游 raw GLSL 的六个 pass **用 TSL 重写**（WebGPU 的 NodeMaterial 库没有 ShaderMaterial），
加火花池 / 落点爆壳 / 地面冲击环共 9 个 mesh，单槽生命周期、空闲全部 `visible=false`。
UI 侧一个独立的准心蓄力环（DOM/SVG）。

**Tech Stack:** three r185.1 WebGPU + TSL（本地 `vendor/three/`）、浏览器内单测 `src/tests/`、
Playwright + pngjs（Tier 4）。**零新增依赖、零新增美术资源、零烘焙产物。**

**Spec:** `docs/superpowers/specs/2026-11-19-nova-beam-sword-charge-design.md`

## Global Constraints

- **短按左键行为逐位不变**：按下边沿仍立刻挥一刀（`_tryFire` 原样），`fireOnce()` 语义不变，
  剑仍无 `automatic`（按住不连砍）。`test-weapons.js:927` 那条冻结用例必须仍绿。
- **伤害派生不复制**：`novaBeam.damage = EXPLOSION_DAMAGE`（`voxel/explosion.js`），
  全仓不得出现第二份 `50` 字面量。
- **走 `damageEntity` 不走 `_damageEntitiesInRadius`**：后者只遍历丧尸，Boss 打不到（spec §2.3③）。
- **不破坏方块**：光柱路径不得调 `editor.setBlock/setBlocks`，不读 `blockDamageEnabled`。
- **不击退**（炸弹不击退）、**不震屏**、**不全屏闪白**、**不做地面焦痕贴花**、**不做调参坞**。
- **音效零新增素材**：只用 `SOUND_IDS` 里已有的 `emp_activated` / `gun_load` / `dragon_fire` / `explosion`。
- **`pointerUp()` 可不带 aim 调用**（既有 5 处单测/spec 这么调）：无 aim 只清状态，不施法、不抛错。
- **新事件一律带 `recoil: 0`**，且 `_applyWeaponEffect` 对蓄力/光柱事件**不调 `viewWeapon.onShot`**
  —— 否则 `_recoil = undefined` → NaN → 剑体消失。
- **TSL 常量色显式拆分量** `vec3(c.r, c.g, c.b)`；`vec3(new THREE.Color(hex))` 在 WebGPU 输出纯黑且零报错。
- **九个材质一律 `fog: false`**（`scene.fogNode` 存在，否则远处光柱被雾洗白）；
  `transparent: true` / `depthWrite: false` / `depthTest: true` / `side: DoubleSide` /
  `renderOrder = 3` / `frustumCulled = false`。
- **不引入 `viewportDepthTexture()` / `viewportTexture()` / `pass()`**：它们会 `currentPass.end()`
  重开 render pass，撞 v3.17 撕天空那类时机缺陷。深度软相交不移植。
- **蓄力环不得挂进 `#crosshair`**（`tests/crosshair.spec.mjs:99` 钉死它只有两笔 `['20x2','2x20']`）；
  独立元素挂 `document.body`，`z-index: 50`，`pointer-events: none`，**不得取 100+**。
- **依赖方向**：`player/weapons/nova-beam.js` 与 `render/nova-beam-config.js` **无 three**；
  `render/nova-beam-{geometry,material,renderer}.js` 只主线程；`entities/entity-manager.js` 属同构层，
  **不得 import three**。
- **资源 URL 只走 `resourceUrl()`**（本轮无新资源，但不得写根绝对路径）。
- **时间基准 `performance.now()`**，禁 `Date.now()`。
- **`assertEqual` 是 `===`**，数组用 `assertDeepEqual`；`assertClose` **不在 `assert.js` 里**，
  要用得在测试文件内自定义。
- **新 `src/tests/test-*.js` 必须同时注册进 `src/tests/index.html`**（漏注册 = 静默不跑）
  且加进 `tools/test-tiers.mjs` 的 `UNIT_NODE_SAFE`；新 spec 加进 `ENTITY` 档。
- **不动 bench 冻结基线**（`docs/m3-baseline.*`）：光柱空闲 0 draw call ⇒ 基线逐位不变。
  诊断跑过 bench 后要 `git checkout` 恢复。
- **不提交**（用户未下提交指令）；每个 Task 末尾的 commit 步骤**跳过**，改为跑验证。
- 中文注释；不加 inline 版权头；不引新依赖。
- **浏览器验证用本仓 `npm start`（8081）**；跑之前核对端口归属（`lsof -ti:8081` → `lsof -p <pid>` 看 cwd）。

## Review Focus

按「改坏了多久能被发现」排序，这七条是 spec 隐含但最容易静默失效的：

1. **短按行为被改掉** —— 用户明确「短按就是普通挥剑」。按下时机/伤害/音效/动画任何一项变了都是回归。
   → Task 3 的「按下边沿仍砍一刀 + 按住不连砍」零回归用例。
2. **只打丧尸，Boss 不掉血** —— 复用 `_damageEntitiesInRadius` 的形态，计数类判据全绿。
   → Task 7 的焰魔扣血用例（同步读，防 AI 位移混入）。
3. **三层塌成一根白棒 / 线圈没画** —— ACES 削顶或 `vec3(Color)` 纯黑，而「变亮」判据仍绿。
   → Task 7 的**双色彩簇**判据（青白簇与金色簇都必须存在）。
4. **单射线漏掉柱内偏心敌人** —— 视觉是粗柱、判定是细线。
   → Task 2 的「偏离轴线 0.5 格命中 / 1.5 格不命中」+ Task 7 的两侧丧尸都掉血。
5. **空闲恒增 9 个 draw call / 破水面顺序不变式** —— `visible` 未归零或 renderOrder 取错。
   → Task 6 的零活跃用例 + Task 7 的 draw call 三态 + 跑 `water-order.spec`。
6. **蓄力环挂进 crosshair** —— 既有像素/DOM 用例立刻红。
   → Task 5 的 DOM 契约用例。
7. **`onShot` 收到无 recoil 的新事件 → NaN → 剑体消失** —— 而蓄力/光柱本身的判据全绿。
   → Task 3 的事件字段断言 + Task 7 的「施法后剑体仍在屏上」像素判据。

---

### Task 1: catalog 数值 + 蓄力/几何纯函数（Tier 1，TDD）

**Files:**
- Modify: `src/player/weapons/weapon-catalog.js`（追加 `novaBeam` 块 + import `EXPLOSION_DAMAGE`）
- Create: `src/player/weapons/nova-beam.js`（three-free 纯函数）
- Create: `src/tests/test-nova-beam.js`
- Modify: `src/tests/index.html`（注册）
- Modify: `tools/test-tiers.mjs`（`UNIT_NODE_SAFE` 加 `'test-nova-beam.js'`）

**Interfaces:**
- Produces:
  - `WEAPONS.sword.novaBeam`（字段与取值见 spec §4.1，逐字照抄）
  - `novaChargeProgress(elapsedSeconds, cfg) → number`（`clamp(elapsed/chargeSeconds, 0, 1)`）
  - `novaBeamAxis(aim, cfg) → { origin:[x,y,z], target:[x,y,z], side:[x,y,z], length:number }`
    —— `origin = aim.origin + right·handOffset[0] + up·handOffset[1] + forward·handOffset[2]`；
    `side = aim.right`；`length` 由 Task 2 的 sweep 覆盖（本函数先给 `cfg.range`）
  - `novaBeamOffsets(cfg) → Array<[number,number]>` = `[[0,0],[r,0],[-r,0],[0,r],[0,-r]]`，`r = cfg.radius`
- Consumes: 无（首个 Task）

- [ ] **Step 1: 写失败测试 —— 常量与派生**

在 `src/tests/test-nova-beam.js` 写：

```js
test('nova: 伤害派生自 EXPLOSION_DAMAGE，不写第二份字面量', () => {
  assertEqual(WEAPONS.sword.novaBeam.damage, EXPLOSION_DAMAGE);
  assertTrue(Object.isFrozen(WEAPONS.sword.novaBeam));
});
test('nova: 蓄力时长 ≥ 总视觉时长（单槽不重叠的前提）', () => {
  const c = WEAPONS.sword.novaBeam;
  const visual = c.range / c.speed + 0.05 + c.burnSeconds + c.fadeSeconds;
  assertTrue(c.chargeSeconds >= visual, `charge ${c.chargeSeconds} < visual ${visual}`);
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: FAIL，报 `--only 里这些文件不在 Node 白名单内`（先把文件加进 `UNIT_NODE_SAFE` 再跑，
则报 `Cannot read properties of undefined (reading 'damage')`）。两种都算 RED，记录实际输出。

- [ ] **Step 3: 实现 catalog 的 `novaBeam` 块**

按 spec §4.1 逐字加字段（含 `import { EXPLOSION_DAMAGE } from '../../voxel/explosion.js'`）。
注释写清「伤害派生自爆炸常量」「冷却 2.0 的推导见 spec §4.3」。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: 2 例 PASS。

- [ ] **Step 5: 写失败测试 —— 蓄力进度与几何**

```js
test('nova: 蓄力进度线性且钳到 [0,1]', () => { /* 0 / 1s / 2s / 3s → 0 / .5 / 1 / 1 */ });
test('nova: 手点在相机基底上展开，forward=(0,0,-1)', () => {
  const aim = { origin:[10,5,20], forward:[0,0,-1], right:[1,0,0], up:[0,1,0] };
  const a = novaBeamAxis(aim, cfg);
  // origin = [10+0.28, 5-0.22, 20-0.55]；target.z = origin.z - range；side = [1,0,0]
});
test('nova: forward=(-1,0,0) 时 target 沿 -X 延伸', () => { /* 同上换基底 */ });
test('nova: 十字偏移恰好 5 条且四端在半径上', () => {
  const off = novaBeamOffsets(cfg);
  assertEqual(off.length, 5);
  assertDeepEqual(off[0], [0, 0]);
  for (const [a, b] of off.slice(1)) assertClose(Math.hypot(a, b), cfg.radius, 1e-9);
});
```

⚠️ `assertClose` 在本文件内自定义（照 `test-spike-fx.js` 的同名局部工具）。

- [ ] **Step 6: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: FAIL，`novaChargeProgress is not defined` / import 解析失败。

- [ ] **Step 7: 实现 `nova-beam.js` 的三个纯函数**

签名见 Interfaces。`novaBeamAxis` 的 `length` 先返回 `cfg.range`（Task 2 的 sweep 会覆盖）。
文件头注释写明「无 three、无 DOM；入参是 aim 基底不是 yaw —— `_buildAim` 是前向的唯一来源」。

- [ ] **Step 8: 跑测试确认 GREEN + 注册门禁**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js && npm run check`
Expected: 6 例 PASS；`check:data` 的 `[测试注册]` 与 `[测试分档]` 两环节通过。

- [ ] **Step 9: commit（跳过 —— 用户未下提交指令）**

---

### Task 2: `EntityManager.raycastAll` + 五射线扫描（Tier 1，TDD）

**Files:**
- Modify: `src/entities/entity-manager.js`（新增 `raycastAll`，既有 `raycast` 一行不改）
- Modify: `src/player/weapons/nova-beam.js`（追加 `novaBeamSweep`）
- Modify: `src/tests/test-nova-beam.js`

**Interfaces:**
- Consumes: Task 1 的 `novaBeamAxis` / `novaBeamOffsets` / `WEAPONS.sword.novaBeam`
- Produces:
  - `EntityManager.raycastAll(origin, dir, maxDist, predicate) → Array<{id,type,dist,point}>`（dist 升序）
  - `novaBeamSweep({ world, entities, isHittable, aim, cfg })
       → { origin, target, side, length, hits: Array<{id,type,dist}> }`
    —— **纯函数，不扣血**；`length = min(cfg.range, 轴线 DDA 距离)`；
    五条射线各取 `min(cfg.range, 该条 DDA 距离)` 作 maxDist，按 id 并集去重保留最近 dist

- [ ] **Step 1: 写失败测试 —— `raycastAll` 语义**

用 `probeDefinition` + 真 `EntityManager` 造 3 个 probe（dist 1/3/5），断言：
返回 3 项且 dist 升序；`predicate` 过滤生效；`maxDist=2` 只剩 1 项；空集合返回 `[]`；
**最近一项与 `raycast()` 的返回逐位一致**（同一份 `raycastAabb` 权威）。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: FAIL，`entities.raycastAll is not a function`。

- [ ] **Step 3: 实现 `raycastAll`**

与 `raycast` 共用归一化与 `definition.raycastAabb`；收集全部命中后 `sort((a,b)=>a.dist-b.dist)`。
注释写明「既有 `raycast` 一行不改 ⇒ 武器/弹丸/炮塔行为逐位不变」。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: 新增 5 例 PASS。

- [ ] **Step 5: 写失败测试 —— 五射线扫描的六个判据**

造合成 `world`（`getBlockId` 由一张 `Map` 驱动）+ 假 `entities`（只实现 `raycastAll`，
内部用真 `raycastAabbSlab` 对一组 AABB 求交，**不自己写几何**）：

```js
test('nova sweep: 轴上敌人命中', …);
test('nova sweep: 偏离轴线 0.5 格（< radius）命中', …);
test('nova sweep: 偏离轴线 1.5 格（> radius）不命中', …);
test('nova sweep: 墙后敌人不命中（DDA 截断）', …);
test('nova sweep: 同一敌人被多条射线命中只出现一次', …);
test('nova sweep: 超 range 不命中；length 取轴线 DDA 距离', …);
```

⚠️ 最后一条要造「轴线 8 格处有墙、但某条偏移射线 20 格无遮挡」的场景，
断言 `length === 8`（**不是** 五条最小值，也不是 20）。

- [ ] **Step 6: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: FAIL，`novaBeamSweep is not defined`。

- [ ] **Step 7: 实现 `novaBeamSweep`**

用 `raycastVoxel(world, origin_i, forward, cfg.range)` 取每条的 `blockDist`（`hit ? dist : Infinity`），
再 `entities.raycastAll(origin_i, forward, min(cfg.range, blockDist), isHittable)`。
`isHittable` 缺省 `(e) => e.type === 'zombie'`（与 controller 同口径）。
注释写明「十字而非 3×3：四角 √2·r 落在圆柱外」「视觉长度取轴线那条」。

- [ ] **Step 8: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: 新增 6 例 PASS，累计 17 例。

- [ ] **Step 9: commit（跳过）**

---

### Task 3: controller 蓄力状态机（Tier 1，TDD）

**Files:**
- Modify: `src/player/weapons/weapon-controller.js`
- Modify: `src/tests/test-nova-beam.js`

**Interfaces:**
- Consumes: Task 1 的 `novaChargeProgress` / catalog；Task 2 的 `novaBeamSweep`（经注入）
- Produces:
  - `WeaponController.pointerUp(aim?)`（**新增可选参数**）
  - `WeaponController.debugState()` 追加 `novaCharge: number`（0..1）与 `novaCharged: boolean`
  - `entityQuery.sweepBeam?: (aim, cfg) => sweepResult`（Game 注入，缺省 null）
  - 三种新效果事件（都带 `recoil: 0` / `impacts: []`）：
    - `{ type:'nova-charge-start', weaponId, sound, volume, recoil:0, impacts:[] }`
    - `{ type:'nova-charge-ready', weaponId, sound, volume, recoil:0, impacts:[] }`
    - `{ type:'nova-beam', weaponId, sound, volume, recoil:0, impacts:[], origin, target, side, length, seed, hits, impactSound, impactVolume }`

- [ ] **Step 1: 写失败测试 —— 零回归 + 蓄力时序**

```js
test('nova: 短按（0.3s）松开只有 melee，无 nova-beam', …);
test('nova: 按住 2.0s 松开恰好一个 nova-beam 事件', …);
test('nova: 蓄满不松开不施法', …);
test('nova: 蓄满音只在越过阈值那一帧响一次', …);
test('nova: select 切武器清蓄力', …);
test('nova: 冷却期内蓄满松开不施法', …);
test('nova: pointerUp() 无 aim 不抛错不施法', …);
test('nova: 三种新事件都带 recoil:0（防 onShot 写出 NaN）', …);
test('nova: 按下边沿仍砍一刀、按住不连砍（既有剑行为零回归）', …);
```

最后一条**照抄** `test-weapons.js:927` 的断言结构（`damageCalls.length` 三次都是 1）。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: FAIL，`novaCharge` 为 undefined / 无 `nova-beam` 事件。

- [ ] **Step 3: 实现状态机**

按 spec §4.4 的伪码改 `pointerDown` / `update` / `pointerUp` / `select` / `debugState`，
新增 `_fireNovaBeam(aim, weapon)`：
- `sweepBeam` 已注入 → 用它的结果；未注入 → `novaBeamAxis` 拿几何、`hits: []`（不扣血不报错）。
- 扣 `cooldown = cfg.cooldown`、`shotsFired++`、`lastEffect` / `onEffect` 照既有口径。
- `seed` 用 `Math.random() * 100`（纯视觉，不入存档，与上游 `_seed` 同口径）。

⚠️ `update` 里蓄力推进必须在 `automatic` 早退**之前**（剑无 `automatic`，否则永不推进）。

- [ ] **Step 4: 跑测试确认 GREEN + 既有武器单测零回归**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js,test-weapons.js`
Expected: 两文件全绿（`test-weapons.js` 例数与改动前相同）。

- [ ] **Step 5: commit（跳过）**

---

### Task 4: 几何 + 观感常量 + TSL 九个材质（Tier 1 结构判据 + Tier 4 兜底）

**Files:**
- Create: `src/render/nova-beam-config.js`（**three-free**，`NOVA_BEAM_FX` 观感常量）
- Create: `src/render/nova-beam-geometry.js`
- Create: `src/render/nova-beam-material.js`
- Modify: `src/tests/test-nova-beam.js`（结构判据段）

**Interfaces:**
- Consumes: Task 1 的 catalog（半径/时长等玩法量从它派生，不写第二份）
- Produces:
  - `NOVA_BEAM_FX`（冻结）：`gain`（初值 1.0，Tier 4 标定）、九个 pass 的宽度/权重/配色 hex、
    `sparkCapacity: 768`、`renderOrder: 3`、`tubeNodes: 96` / `tubeSides: 26` /
    `coilNodes: 128` / `coils: 4` / `ringSegments: 44` / `rings: 10`
  - `createBeamTubeGeometry(nodes, sides) → BufferGeometry`（position = `(t, a, 0)`）
  - `createBeamCoilGeometry(nodes, strands) → InstancedBufferGeometry`（+ `aStrand`）
  - `createBeamRingGeometry(rings, segments) → InstancedBufferGeometry`（position = `(band, a, 0)`，+ `aRing`）
  - `createSparkGeometry(capacity) → InstancedBufferGeometry`（quad + 六个 instanced 属性）
  - `createNovaBeamMaterials() → { halo, shell, core, coil, ring, orb, spark, burst, shock, uniforms }`
    —— `uniforms` 是**九个材质共享的同一组** uniform 句柄（`uTime/uOrigin/uTarget/uSide/uProgress/
    uFade/uWidthFade/uCharge/uSeed/uLength/uRadius/uRadiusNear/uRadiusCurve/uGain`）
  - 每个 pass 内部用 `varyingProperty('float','vNbT')` 等**逐 pass 命名**的 varying 在顶点阶段写、
    片元阶段读（`vNbT` / `vNbFacing` / `vNbSide` / `vNbBand` / `vNbPhase` / `vNbAge` / `vNbSeed`）。
    ⚠️ **不得在 `colorNode` 里直读 `positionGeometry`** —— 那会在片元阶段重新求值参数化顶点，
    而 `aStrand`/`aRing` 是 instanced 属性，片元阶段读不到 ⇒ 静默拿到 0。

- [ ] **Step 1: 写失败测试 —— 几何与材质结构**

```js
test('nova geo: tube 顶点是参数 (t,a,0)，不含米数', …);   // 逐顶点 |x|<=1, |y|<=1, z===0
test('nova geo: tube 的 seam 列重复（a 达到 1.0）', …);  // 每行最后一顶点 y===1
test('nova geo: coil/ring 是 InstancedBufferGeometry 且 instanceCount 正确', …);
test('nova geo: spark 容量 768 且六个 instanced 属性齐全', …);
test('nova mat: 九个材质全部 fog:false / depthWrite:false / transparent / DoubleSide', …);
test('nova mat: 九个材质共享同一组 uniform 句柄（改一处九处生效）', …);
test('nova mat: 每个 pass 都设了 vertexNode（世界空间摆放）', …);
test('nova fx: 观感常量冻结，玩法量从 catalog 派生', …);
```

⚠️ 材质构造需要 three 但**不需要 GPU**（Node 白名单里 `test-turret-top-bake.js:343` 已有先例：
`await import('three')` + `new THREE.Scene()`）。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `nova-beam-config.js`**

配色逐项取 spec §6.3 的 hex；玩法量 `radius/radiusNear/radiusCurve/burnSeconds/fadeSeconds`
从 `WEAPONS.sword.novaBeam` 派生。文件头写明「three-free，Tier 1 可直接 import」。

- [ ] **Step 4: 实现 `nova-beam-geometry.js`**

三个参数化几何逐字照上游 `ProceduralGeometry.js:360/426/478` 的顶点/索引构造
（**seam 列必须重复**，让 `a` 到 1.0 而不是 wrap 到 0，否则角向噪声出现硬接缝）。
`boundingSphere = new Sphere(new Vector3(), 1e4)`（世界空间由 shader 摆放）。
火花 quad：`position` 四角 `(±0.5, ±0.5, 0)`，instanced 属性
`aOrigin(vec3) / aVel(vec3) / aSpawn(float) / aLife(float) / aSize(float) / aSeed(float)`。

- [ ] **Step 5: 实现 `nova-beam-material.js`**

按 spec §6.2 四条口径：
- `vertexNode = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(here, 1)))`（世界空间摆放）；
  火花走视图空间 billboard。
- **逐 pass 的 varying 用 `varyingProperty`**：在 `vertexNode` 的 `Fn` 里 `.assign(...)`，
  在 `colorNode` 里直读。名字逐 pass 唯一（`vNbT` / `vNbFacing` / …），避免九个材质串号。
- `ridgedFbm` 用 `Fn` + `Loop(4)` 重建（`1 − abs(mx_noise_float(q))`，`q *= 2.06`，`amp *= 0.5`）。
- 反向 smoothstep 一律写 `oneMinus(smoothstep(lo, hi, x))`。
- 常量色 `vec3(c.r, c.g, c.b)`。
- 三层加权：`vFacing = abs(dot(normalize(cameraPosition - here), nrm))`；
  CORE 用 `pow(facing, coreSharp)`，SHELL/HALO 用 `pow(1 - facing, edgePower)`。
- `colorNode = vec4(rgb, alpha)`，`opacityNode` 不另设（alpha 已在 colorNode 里）。
- 九个材质共用同一组 uniform（**一次 `uniform()` 创建，九个材质引用同一句柄**）。
- `alpha.lessThanEqual(0.003).discard()` 代替上游的 `if (alpha < 0.003) discard`。

- [ ] **Step 6: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js && npm run check`
Expected: 新增 8 例 PASS；lint 无新增 warning（单独跑 `npx eslint src/render/nova-beam-*.js` 确认）。

- [ ] **Step 7: commit（跳过）**

---

### Task 5: 渲染器单槽生命周期 + 准心蓄力环（Tier 1，TDD）

**Files:**
- Create: `src/render/nova-beam-renderer.js`
- Create: `src/ui/nova-charge-ring.js`
- Modify: `src/tests/test-nova-beam.js`

**Interfaces:**
- Consumes: Task 4 的几何/材质/uniform 句柄；Task 1 的 catalog
- Produces:
  - `NovaBeamRenderer({ scene })`：
    - `meshes: THREE.Object3D[]`（9 个，供水面倒影 hidden 列表）
    - `setCharge(progress, origin, side, nowMs)`
    - `fire({ origin, target, side, length, seed }, nowMs)`
    - `update(nowMs, dt)`
    - `get active(): boolean` / `get phase(): 'idle'|'travel'|'burn'|'fade'`
    - `dispose()`
  - `NovaChargeRing(root)`：`update(progress)` / `dispose()`；
    元素 id `mc-nova-charge`，`NOVA_CHARGE_Z_INDEX = 50`

- [ ] **Step 1: 写失败测试 —— 生命周期与池化**

```js
test('nova renderer: 构造后九个 mesh 全部 visible=false', …);
test('nova renderer: setCharge(0) 不点亮任何 mesh', …);
test('nova renderer: setCharge(0.5) 只点亮 orb', …);
test('nova renderer: fire 后 phase=travel，柱身三层可见', …);
test('nova renderer: travel→burn→fade→idle 的相位推进（喂固定 dt）', …);
test('nova renderer: 结束后九个 mesh 回到 visible=false', …);
test('nova renderer: 非法 nowMs / NaN 坐标不污染池', …);
test('nova ring: progress=0 时隐藏，>0 时可见且 dashoffset 单调递减', …);
test('nova ring: z-index 50 且 pointer-events:none', …);
```

⚠️ 渲染器测试用真 three 对象（无 GPU），照 `test-spike-fx.js` 的 `new THREE.Scene()` 手法。
⚠️ 环的测试需要 DOM ⇒ **留在浏览器档**，故环的判据放 `tests/nova-beam.spec.mjs`（Task 7），
本 Task 只测渲染器；`test-nova-beam.js` 保持 Node 可跑。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: FAIL，`NovaBeamRenderer is not defined`。

- [ ] **Step 3: 实现渲染器**

按 spec §6.5 的相位机。要点：
- 九个 mesh 全部 `renderOrder = NOVA_BEAM_FX.renderOrder` / `frustumCulled = false` /
  初始 `visible = false`。
- `uTime` 每帧写 `(nowMs - bornAt) / 1000`；`uProgress` 在 travel 期为 `u`，之后恒 1。
- `fade` / `widthFade` 两条曲线分开（`inCubic` vs `outCubic`，见 spec §6.5）。
- 火花环形缓冲：CPU 只写出生数据，`aSpawn` 用**相对 bornAt 的秒**（避免绝对时间戳精度问题）。
- 三种发射（吸入 / 柱身喷溅 / 落点回溅）按 spec §6.4；发射率用**分数速率累加器**
  （`acc += rate*dt; n = floor(acc); acc -= n`）保证帧率无关。
- 落点爆壳与地面冲击环在 burn 期按周期发射（复用同一 mesh 的 scale/opacity 包络）。
- 每个 spawn 前 `Number.isFinite` 逐项守卫。

- [ ] **Step 4: 实现蓄力环**

按 spec §7.2：SVG `<circle r=18>` + `stroke-dasharray = 2πr` / `stroke-dashoffset = C·(1−p)`，
`transform: rotate(-90deg)`；`p<1` 用 `#7ff0ff`，`p>=1` 用 `#ffd75e` + 外发光呼吸。
`p===0` → `opacity:0; visibility:hidden`。进度变化 ≤0.005 时跳过 DOM 写。
**挂 `root`（Game 传 `document.body`），不碰 `#crosshair`。**

- [ ] **Step 5: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: 新增 7 例 PASS（环的 2 例移到 Task 7）。

- [ ] **Step 6: commit（跳过）**

---

### Task 6: 装配接线（Game + Player + 性能面板）

**Files:**
- Modify: `src/core/game.js`（装配 / 注入 `sweepBeam` / 帧循环 / 倒影 hidden / dispose）
- Modify: `src/player/player.js`（`pointerUp` 传 aim、`_applyWeaponEffect` 分流新事件）
- Modify: `src/core/perf-hud.js`（`HELP_LINES` 追加一行）
- Modify: `src/tests/test-nova-beam.js`（装配层判据）

**Interfaces:**
- Consumes: Task 2 的 `novaBeamSweep`；Task 3 的 `sweepBeam` 契约与三种事件；Task 5 的两个类
- Produces:
  - `Game.novaBeam: NovaBeamRenderer`
  - `Game._novaChargeRing: NovaChargeRing`
  - `Game._novaBeamSweep(aim, cfg)`（调纯函数 + 逐个 `damageEntity`）
  - `Game.novaBeamDebugState() → { active, phase, charge, charged, drawCalls }`

- [ ] **Step 1: 写失败测试 —— 装配层契约**

用 `Object.create(Game.prototype)` + 注入最小依赖（照 `test-tnt-chain.js` 手法）：

```js
test('nova 装配: _novaBeamSweep 对每个 hit 调一次 damageEntity，金额 = cfg.damage', …);
test('nova 装配: hits 为空时不调 damageEntity', …);
test('nova 装配: 不调 editor.setBlock/setBlocks（不破坏方块）', …);
test('nova 装配: 不调 knockbackEntity（不击退）', …);
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js`
Expected: FAIL，`_novaBeamSweep is not a function`。

- [ ] **Step 3: 接线 Game**

- 构造段（`spikeFx` 之后）：`this.novaBeam = new NovaBeamRenderer({ scene: this.scene })`。
- HUD 段（`crosshair` 之后）：`this._novaChargeRing = new NovaChargeRing(document.body)`。
- `setEntityQuery` 追加 `sweepBeam: (aim, cfg) => this._novaBeamSweep(aim, cfg)`。
- `_novaBeamSweep`：调 `novaBeamSweep({world, entities, isHittable, aim, cfg})`，
  对每个 hit 调 `this.damageEntity(hit.id, cfg.damage, performance.now())`，返回几何 + hits。
- 帧循环（`spikeFx?.update` 之后）：`this.novaBeam.update(nowMs, dt)`；
  读 `player.weaponDebugState()` 的 `novaCharge` → 若 >0 则
  `novaBeam.setCharge(p, handPoint, side, nowMs)`，并 `_novaChargeRing.update(p)`；
  否则 `setCharge(0, …)` + `ring.update(0)`。
- `_renderWaterReflection` 的 `hidden` 追加 `...this.novaBeam.meshes`。
- `dispose()` 追加 `this.novaBeam?.dispose()` / `this._novaChargeRing?.dispose()`。

- [ ] **Step 4: 接线 Player**

- `onMouseUp`：`this.weaponController.pointerUp(this._buildAim())`。
- `_applyWeaponEffect`：开头分流 —— `nova-charge-start` / `nova-charge-ready` 只播音；
  `nova-beam` 播音 + `this.novaBeamRenderer?.fire(...)`（经 `weaponRuntime` 注入）+ 落点音。
  **三者都不调 `viewWeapon.onShot`**（Global Constraints）。
- `weaponRuntime` 追加 `novaBeamRenderer`；Game 构造 Player 时传入。
- `weaponDebugState()` 已含 controller 的 `novaCharge`（Task 3 加的），无需再改。

- [ ] **Step 5: 性能面板加一行**

`HELP_LINES` 追加 `'剑长按2秒：Nova Beam'`（实测行宽 132px < 可用 310px）。

- [ ] **Step 6: 跑测试确认 GREEN + 全量单测**

Run: `node tools/run-unit-node.mjs --only=test-nova-beam.js && npm run check && node tools/run-unit-node.mjs`
Expected: 新例 PASS；`check` 三门通过；Node 轻档全绿（例数 = 改动前 + 本轮新增）。

- [ ] **Step 7: commit（跳过）**

---

### Task 7: Tier 4 像素实测 + E2E + 分档 + 文档

**Files:**
- Create: `tests/nova-beam.spec.mjs`
- Modify: `tools/test-tiers.mjs`（`ENTITY` 加 `'nova-beam'`）
- Modify: `docs/roadmap.md`（v3.20 行）
- Modify: `CLAUDE.md`（高频坑，**`git add CLAUDE.md`** —— AGENTS.md 是符号链接）

**Interfaces:**
- Consumes: Task 6 的 `Game.novaBeamDebugState()` / `player.weaponController` 公开 API
- Produces: 无（验收层）

- [ ] **Step 1: 写 spec —— DOM 契约 + 蓄力环**

```js
test('蓄力环：短按不出现；按住 1s 出现且 dashoffset 单调递减；2s 转就绪色；松开消失', …);
test('蓄力环不是 #crosshair 的子节点（DOM 契约）', …);
```

第二条同时断言 `#crosshair` 的 children 仍是 `['20x2','2x20']`。

- [ ] **Step 2: 写 spec —— Tier 4 双色彩簇**

同机位同地形，两侧只差有没有 `fire`；**两侧都先 `viewWeapon.node.visible = false`**
（藏掉紫色剑体这个噪声源，同焰魔法阵 v3.04 教训）。判据：
- 差分像素数 > 阈值（光柱真的上屏）；
- 差分里**青白簇**（`b > r + 20 && g > r`）与**金色簇**（`r > g + 20 && g > b + 20`）**都** > 阈值；
- 近白像素占比有**上界**（防三层塌成白棒）。

⚠️ 阈值必须在 **1280×720**（Playwright 默认 viewport）下标定，先跑一次打印实际值再定阈值。

- [ ] **Step 3: 写 spec —— 玩法七条**

```js
test('丧尸 100 → 50（一次，燃烧期不重复扣）', …);
test('焰魔 3500 → 3450（同步读，防 AI 位移混入）', …);
test('轴线两侧各 0.5 格的两只丧尸都掉血（证明不是单射线）', …);
test('光柱不破坏方块（即使 gunBlockDamage 开着）', …);
test('墙后丧尸不掉血且 length 被截断', …);
test('draw call：空闲=基线 / 施放中=基线+9 / 结束后回基线', …);
test('连续 3 次蓄力+释放无泄漏（mesh 数不变、draw call 回基线）', …);
test('施法后剑体仍在屏上（防 onShot NaN）', …);
test('负向对照：拆掉 sweepBeam 注入 → 伤害消失而视觉仍在', …);
```

⚠️ 开阔地传送用 `g._teleportTo(x, 45, z)` + 等 2.5s（`player.spawn` 不加载 column，会 30s 超时）。
⚠️ 焰魔那条照 `tests/sword.spec.mjs:646` 的祭坛高台地带夹具（seed 12345 + `summonBoss` 两次）。

- [ ] **Step 4: 跑 spec 确认 RED→GREEN**

Run: `npx playwright test tests/nova-beam.spec.mjs`
Expected: 先按实际读数标定阈值（打印 → 定值），最终全绿。**不接管道**（`| grep` 会吃掉退出码）。

- [ ] **Step 5: 跑既有相关 spec 零回归**

Run: `npx playwright test tests/sword.spec.mjs tests/crosshair.spec.mjs tests/water-order.spec.mjs tests/player-flight.spec.mjs tests/unit-fast.spec.mjs`
Expected: 全绿。`player-flight` 的「面板宽度 330 + 无横向溢出」两条必须仍成立。

- [ ] **Step 6: bench 回归门**

Run: `npm run bench -- --check`
Expected: 退出码 0（光柱空闲 0 draw call ⇒ 基线逐位不变）。
若诊断期跑过不带 `--check` 的 bench，`git checkout docs/m3-baseline.md docs/m3-baseline.json` 恢复。

- [ ] **Step 7: 文档**

- `docs/roadmap.md` 加 v3.20 行（用户原话 / 三条裁定 / 实测读数 / 新增门禁）。
- `CLAUDE.md` 高频坑加本轮实测教训（至少：WebGPU 无 ShaderMaterial、`toneMapped` 不存在、
  `viewportDepthTexture` 会重开 pass、双色彩簇判据、蓄力环不得挂 crosshair）。

- [ ] **Step 8: 全量门**

Run: `npm run check && node tools/run-unit-node.mjs --all && npx playwright test tests/nova-beam.spec.mjs`
Expected: 全绿。

- [ ] **Step 9: commit（跳过）**

---

## Self-Review

**1. Spec coverage**：§4.1→T1；§4.4→T3；§4.5→T2；§5.2→T2；§5.3→T6；§6.1-6.3→T4；
§6.4-6.5→T5；§6.6→T6；§7.1-7.2→T5；§7.3→T6；§8.1→T1/T2/T3/T5/T6；§8.2→T7；§8.3→T7。
§9 的七条风险分别落在 T3（NaN）、T4（纯黑/ACES/fog）、T5（粒子 NaN）、T6（顺序）、T7（判据）。无缺口。

**2. Step scan**：每步一个动作 + 一个可核对结果。算法体只在「signature 与测试决定不了」处给
（`ridgedFbm` 的 Loop 结构、三层加权公式、十字偏移表）—— 其余给签名与判据。

**3. Type consistency**：`novaBeamAxis` / `novaBeamOffsets` / `novaBeamSweep` / `raycastAll` /
`sweepBeam` / `setCharge` / `fire` / `update` / `meshes` / `novaCharge` 在各 Task 的 Interfaces
里名字与形状一致；`NOVA_BEAM_FX.renderOrder` 在 T4 产出、T5 消费。

**4. Review Focus**：七条各有归属 Task 与具体用例（见该节）。

**5. Proportion**：本计划 ~330 行 vs spec ~330 行，代码块只占测试断言与三处算法，不是程序转录。