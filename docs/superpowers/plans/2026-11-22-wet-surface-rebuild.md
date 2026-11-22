# 雨天光影重做（按材质分类的湿表面）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task（用户已指定 **Native 内联执行**，不派 subagent）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 废弃上游湿地面与整条后处理链，按材质分类从零实现「压暗 + 有界天空反光 + 弱太阳高光 + 积水斑」的湿表面，消除岩壁与高空云层的光晕，雨的全部效果原样保留。

**Architecture:** 材质分类走 `packed` bit15–18（4 bit，9 类）—— 零顶点字节增量；分类数据在 `voxel/wet-material-data.js`，registry 派生 `wetClassTable`，mesher 写位；顶点阶段查 `uniformArray` 得逐 quad 常量 vec4，经一个 varying 传片元；片元用「既有雾色↔天顶色按反射方向插值」当天空环境，`mix` 而非 `add` 合成（天然有界）。雨天档回到单 `renderer.render()`。

**Tech Stack:** three r185.1 本地 vendor（WebGPU 唯一后端）+ TSL；Node v26 单测（`tools/run-unit-node.mjs`）；Playwright + pngjs 做 Tier 4 像素实测。

**Spec:** `docs/superpowers/specs/2026-11-22-wet-surface-rebuild-design.md`

## Global Constraints

以下每条对**所有** Task 生效，值逐字取自 spec：

- **禁止给体素新增顶点属性**：三通道静态 `gpuVertexBytes` = **193.83 MiB**，`tests/m3-fullscene.spec.mjs:98` 的门是 **200 MiB**；加一个 float 属性 = +25.84 MiB ⇒ 219.68 MiB 超门。分类只能进 `packed` 空闲位。
- **`packed` 位段**：bit0–7 light / bit8–9 AO / bit10–12 face / bit13 emissive / bit14 noShadowCast **逐位不变**；新增 **bit15–18**（4 bit，mask `0xF`）。
- **不改 `blocks-data.js` 的方块顺序或数量**（159 项）⇒ `registry.fingerprint()` 与 `fingerprintOfPrefix(n)` 逐位不变 ⇒ 旧存档零影响。
- **依赖方向** `voxel ← gen ← mesh ← render`，`core/` 可依赖任何层。`voxel/gen/mesh/workers/entities` **不得 import three、不得引用 DOM**（`tools/check-architecture.mjs` 静态门）。
- **不新建第二条 reflector pass、不新增任何 render pass**。雨天档走 `renderer.render()`。
- **反光用 `mix` 不用 `add`**（加法在亮端必钳白）。
- **积水噪声用 `mx_noise_float`**，禁止 `hash(floor(uv))`（会出轴对齐矩形斑）。
- **TSL 六条口径**：① 节点不与裸 JS 数字算术，一律 `.mul()/.add()`；② 常量色显式拆 `.r/.g/.b`（`vec3(Color)` 在 WebGPU 静默输出纯黑）；③ 多层 `mix` 嵌套，不链式 `.mix()`；④ 径向量（V/R/H/NoV）全在**片元**算；⑤ 不用 `.toVar()/.assign()`（`createWetSurfaceNode` 在 `makeMaterial` 里直接调，不在 `Fn()` 体内 ⇒ 报 No stack defined）；⑥ 反向 smoothstep 写 `oneMinus(smoothstep(lo,hi,x))`。
- **时间基准** `performance.now()`，禁止 `Date.now()`。
- **面板文案与落位一字不动**：`STORM_ROW_TITLE='雨天光影'`、`STORM_LABELS=['关闭','开启']`、左列瞬移行下方（三处面板高度冻结断言）。
- **保留不动**：`storm-rain.js` / `storm-rain-config.js` / `storm-rain-material.js` / `rain-shelter.js` / `water-surface.js` / `rain.js` / `weather.js` / 雨声与远雷 / 天气快照还原 / `tests/storm-audio-off.spec.mjs` / `src/tests/test-rain-shelter.js` / `src/tests/test-water-surface.js` / `tools/bake-carbine-audio.mjs` 及指纹门禁。
- **测试命令不接管道**（`| tail` 会把退出码换成管道末端工具的）。预计 >1 分钟的命令用 `run_in_background`。
- **不擅自改冻结阈值**：数字不符就停下报告。
- **提交**：用户已批准实施；每个 Task 末尾按计划的 commit 步骤提交（Conventional Commits）。`AGENTS.md` 是 `CLAUDE.md` 的符号链接 ⇒ 若改规范一律 `git add CLAUDE.md`。**不 push**。

## Review Focus

spec 隐含、但没有任何 Task 的测试直接覆盖的五类失效（按最可能咬到实玩玩家的顺序）。每条已在其归属 Task 里补了测试：

1. **新增方块漏分类** ⇒ 该方块静默变成「不湿」，玩家看到新建筑在雨里是干的。→ Task 1 Step 1 的覆盖断言（150 项全集对齐）。
2. **`uWetParams` 数组长度与类枚举不同步**（加了第 10 类却忘了扩数组）⇒ `.element(cls)` 越界读到 0 或触发 WGSL 验证错误 ⇒ 整片材质不上屏。→ Task 2 Step 1 的 `WET_CLASS_PARAMS.length === WET_CLASS_COUNT` 断言 + Task 4 Step 1 的「9 项全部有限且 ∈[0,1]」。
3. **`uWet=1` 但材质句柄未接线**（fixture / 早期启动帧）⇒ 天空色停在构造初值，反光颜色错但不报错。→ Task 5 Step 1 的「句柄缺失不抛错 + 首帧写入值正确」。
4. **关闭雨天档后 `uWet` 残留非 0**（`_updateStorm` 早退路径漏写）⇒ 晴天画面仍被压暗。→ Task 6 Step 1 的「关闭后 uWet 恒 0 且连续两帧不变」。
5. **`packed` 高位污染既有位段**（移位算错挤进 bit14）⇒ 阴影投射语义翻转，云开始投影 / 石头不投影。→ Task 3 Step 1 的「bit0–14 逐位等于改动前」+ 既有 `test-mesher.js` 的 bit13/bit14 用例。

---

### Task 1: 材质分类数据层（voxel + registry）

**Files:**
- Create: `src/voxel/wet-material-data.js`
- Modify: `src/voxel/block-registry.js`（新增 `wetClassTable`，`register()` 内派生）
- Test: `src/tests/test-wet-surface.js`（本 Task 建文件，后续 Task 追加用例）
- Modify: `src/tests/index.html`（注册新单测文件）
- Modify: `tools/test-tiers.mjs`（`UNIT_NODE_SAFE` 加 `test-wet-surface.js`）

**Interfaces:**
- Produces:
  - `WET_CLASS = Object.freeze({ NONE:0, POLISHED:1, STONE:2, SOIL:3, WOOD:4, METAL:5, ICE:6, FABRIC:7, PLANT:8 })`
  - `WET_CLASS_COUNT = 9`
  - `WET_CLASS_DATA: Readonly<Record<string, number>>`（150 项，name → class）
  - `wetClassOf(name: string): number`（未列出 ⇒ `WET_CLASS.NONE`）
  - `registry.wetClassTable: Uint8Array`（长度 512，`wetClassTable[id] = wetClassOf(name)`）

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-wet-surface.js` 写（用 `./runner.js` 的 `test` 与 `./assert.js` 的 `assertEqual/assertTrue`，同 `test-ground-reflect.js` 的 import 风格）：

```js
// 覆盖性：每个 opaque/cutout 方块都有显式分类条目
test('wet class: 全部 opaque/cutout 方块都已显式分类（150 项）', () => {
  const target = BLOCKS.filter((b) => b.cullMode === 'opaque' || b.cullMode === 'cutout');
  assertEqual(target.length, 150, 'opaque 105 + cutout 45');
  const missing = target.filter((b) => WET_CLASS_DATA[b.name] === undefined).map((b) => b.name);
  assertEqual(missing.join(','), '', '未分类方块');
  const names = new Set(target.map((b) => b.name));
  const extra = Object.keys(WET_CLASS_DATA).filter((n) => !names.has(n));
  assertEqual(extra.join(','), '', '多余条目（拼错的名字）');
});

test('wet class: cloud 必须是 NONE（用户报告的高空云层光晕的直接防线）', () => {
  assertEqual(wetClassOf('cloud'), WET_CLASS.NONE);
  assertEqual(wetClassOf('lava'), WET_CLASS.NONE);
  assertEqual(wetClassOf('glowstone'), WET_CLASS.NONE);
});

test('wet class: 未列出的名字回落 NONE（安全失败，不会湿错）', () => {
  assertEqual(wetClassOf('__no_such_block__'), WET_CLASS.NONE);
});

test('wet class: registry.wetClassTable 与数据表逐项一致', () => {
  for (const b of BLOCKS) {
    assertEqual(REG.wetClassTable[REG.idOf(b.name)], wetClassOf(b.name), b.name);
  }
});

test('wet class: 新增表不改方块清单指纹（旧存档零影响）', () => {
  // 指纹只哈希有序名字串 ⇒ 加属性表不得改它。基线取「不含 wetClassTable 的注册结果」不可得，
  // 故钉关系式：全量指纹 === 前 count 项指纹，且前缀指纹单调可算（同 test-progress 口径）。
  assertEqual(REG.fingerprint(), REG.fingerprintOfPrefix(REG.count));
  assertTrue(/^[0-9a-f]{8}$/.test(REG.fingerprint()), '32bit 十六进制');
});
```

`REG` 用 `createRegistry()` + 逐条 `register(b.name, b)` + `freeze()`（同 `test-ground-reflect.js`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: 硬失败，报 `--only 里这些文件不在 Node 白名单内`（文件尚未归档）；把它加进 `tools/test-tiers.mjs` 的 `UNIT_NODE_SAFE` 与 `src/tests/index.html` 后重跑，Expected: import 失败 `Cannot find module '../voxel/wet-material-data.js'`。

- [ ] **Step 3: 实现 `src/voxel/wet-material-data.js`**

文件头注明「three-free，Worker 同构」+ 为什么分类不能进顶点属性（引 spec §2.3 的 193.83/219.68 MiB 实测）。
导出 `WET_CLASS` / `WET_CLASS_COUNT` / `WET_CLASS_DATA` / `wetClassOf`。
`WET_CLASS_DATA` 逐字取 spec §5 的九组名单（18+21+16+8+1+3+25+27+31 = 150）。
`wetClassOf(name)` = `WET_CLASS_DATA[name] ?? WET_CLASS.NONE`。

- [ ] **Step 4: 实现 registry 派生**

`src/voxel/block-registry.js`：顶部 `import { wetClassOf } from './wet-material-data.js';`；
新增 `const wetClassTable = new Uint8Array(MAX_BLOCKS);`（附注释说明消费方 = mesher 写 bit15–18）；
`register()` 内 `wetClassTable[id] = wetClassOf(name);`；
返回对象加 `wetClassTable`。**不改 `register()` 签名、不改 `fingerprintOfPrefix` 的循环**。

- [ ] **Step 5: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: 5 例全绿，`failed === 0`。

- [ ] **Step 6: 跑 check 与既有 mesher 单测（确认零回归）**

Run: `npm run check`
Expected: exit 0（`[测试注册]` 与 `[测试分档]` 双向钉住新文件）。
Run: `node tools/run-unit-node.mjs --only=test-mesher.js`
Expected: 全绿（本 Task 未动 mesher，位段未变）。

- [ ] **Step 7: Commit**

```bash
git add src/voxel/wet-material-data.js src/voxel/block-registry.js src/tests/test-wet-surface.js src/tests/index.html tools/test-tiers.mjs
git commit -m "feat(wet): 按材质分类的湿表面数据层（150 方块九类）"
```

---

### Task 2: 类参数表与 CPU 同构纯函数

**Files:**
- Create: `src/render/wet-surface-config.js`
- Test: `src/tests/test-wet-surface.js`（追加）

**Interfaces:**
- Consumes: `WET_CLASS` / `WET_CLASS_COUNT`（Task 1）
- Produces（全部 three-free）:
  - `WET_CLASS_PARAMS: readonly [number,number,number,number][]`，长度 = `WET_CLASS_COUNT`，每项 `(wetGain, darken, rough, specGain)`
  - 常量：`WET_STRENGTH_MAX=1.0`、`WET_WALL_FACTOR=0.22`、`WET_WALL_ROUGH_ADD=0.25`、`WET_REFL_MAX=0.55`、`WET_SUN_SPEC=0.22`、`WET_PUDDLE_SCALE=0.32`、`WET_PUDDLE_FROM=0.52`、`WET_PUDDLE_TO=0.76`、`WET_PUDDLE_ROUGH_K=0.25`、`WET_PUDDLE_DARK_K=0.88`、`WET_PUDDLE_SPEC_K=1.60`、`WET_SKY_BAND`（`{loNear:-0.15, loFar:-0.50, hiNear:0.55, hiFar:1.00}`）、`WET_FRESNEL_F0_BASE=0.02`、`WET_FRESNEL_F0_RANGE=0.04`、`WET_SHININESS`（`{min:6, max:420}`）、`WET_PUDDLE_ROUGH_GATE`（`{from:0.55, to:0.80}`）
  - `wetOrientFactor(up: number): number` — up>0.5 ⇒ 1；up<−0.5 ⇒ 0；否则 `WET_WALL_FACTOR`
  - `wetnessAt(strength, up, cls, worldY, waterY): number` — `clamp(strength × params[cls][0] × wetOrientFactor(up), 0, 1) × wetAboveWaterGate(worldY, waterY)`
  - `wetAboveWaterGate(worldY, waterY): number` — 非有限 ⇒ 1；`worldY < waterY` ⇒ 0；否则 1
  - `wetRoughnessAt(cls, up, puddle): number` — `min(params[cls][2] + (up>0.5?0:WET_WALL_ROUGH_ADD), 1) × (1 + (WET_PUDDLE_ROUGH_K−1)×puddle)`
  - `puddleAllowed(rough): number` — `1 − smoothstep(WET_PUDDLE_ROUGH_GATE.from, .to, rough)`
  - `wetFresnel(noV, rough): number` — Schlick，`F0 = BASE + RANGE×(1−rough)`，`F0 + (1−F0)×(1−clamp(noV,0,1))^5`
  - `wetShininess(rough): number` — `min + (max−min)×(1−rough)^3`
  - `skyEnvMixAt(ry, rough): number` — `smoothstep(mix(loNear,loFar,rough), mix(hiNear,hiFar,rough), ry)`
  - `wetSpecGainAt(cls, puddle): number` — `min(params[cls][3] × (1 + (WET_PUDDLE_SPEC_K−1)×puddle), 1)`
  - `wetDarkenAt(cls, puddle): number` — `params[cls][1] × (1 + (WET_PUDDLE_DARK_K−1)×puddle)`

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-wet-surface.js`：

```js
test('wet params: 数组长度 = 类数，且每项四分量都在 [0,1]', () => {
  assertEqual(WET_CLASS_PARAMS.length, WET_CLASS_COUNT);
  for (const [i, p] of WET_CLASS_PARAMS.entries()) {
    assertEqual(p.length, 4, `类 ${i} 四分量`);
    for (const v of p) assertTrue(Number.isFinite(v) && v >= 0 && v <= 1, `类 ${i} 分量 ${v}`);
  }
});

test('wet params: NONE 是恒等（不湿、不压暗、无镜面）', () => {
  assertDeepEqual([...WET_CLASS_PARAMS[WET_CLASS.NONE]], [0, 1, 1, 0]);
});

test('wet params: 粗糙度按表面致密度单调（抛光 < 石 < 土 < 布）', () => {
  const r = (c) => WET_CLASS_PARAMS[c][2];
  assertTrue(r(WET_CLASS.POLISHED) < r(WET_CLASS.STONE));
  assertTrue(r(WET_CLASS.STONE) < r(WET_CLASS.SOIL));
  assertTrue(r(WET_CLASS.SOIL) < r(WET_CLASS.FABRIC));
});

test('wet params: 布与植被几乎无镜面（<0.1），金属与抛光强（>0.8）', () => {
  const s = (c) => WET_CLASS_PARAMS[c][3];
  assertTrue(s(WET_CLASS.FABRIC) < 0.1);
  assertTrue(s(WET_CLASS.PLANT) < 0.1);
  assertTrue(s(WET_CLASS.METAL) > 0.8);
  assertTrue(s(WET_CLASS.POLISHED) > 0.8);
});

test('wetnessAt: 总强度 0 / 底面 / NONE / 水下 四条都归零', () => {
  assertEqual(wetnessAt(0, 1, WET_CLASS.STONE, 10, -1.5), 0);
  assertEqual(wetnessAt(1, -1, WET_CLASS.STONE, 10, -1.5), 0);
  assertEqual(wetnessAt(1, 1, WET_CLASS.NONE, 10, -1.5), 0);
  assertEqual(wetnessAt(1, 1, WET_CLASS.STONE, -5, -1.5), 0);
});

test('wetnessAt: 侧面 = 顶面 × WET_WALL_FACTOR（墙面只极弱湿）', () => {
  const top = wetnessAt(1, 1, WET_CLASS.STONE, 10, -1.5);
  const side = wetnessAt(1, 0, WET_CLASS.STONE, 10, -1.5);
  assertClose(side, top * WET_WALL_FACTOR, 1e-12);
  assertTrue(side < 0.25, '侧面湿强度必须远小于顶面');
});

test('wetAboveWaterGate: 恰好共面算水上（防边界逐帧翻转）', () => {
  assertEqual(wetAboveWaterGate(-1.5, -1.5), 1);
  assertEqual(wetAboveWaterGate(-1.6, -1.5), 0);
  assertEqual(wetAboveWaterGate(NaN, -1.5), 1);
});

test('wetFresnel: 边界与单调（noV=1 ⇒ F0；noV=0 ⇒ 1；noV 递减 ⇒ F 递增）', () => {
  const f0 = WET_FRESNEL_F0_BASE + WET_FRESNEL_F0_RANGE * (1 - 0.3);
  assertClose(wetFresnel(1, 0.3), f0, 1e-12);
  assertClose(wetFresnel(0, 0.3), 1, 1e-12);
  assertTrue(wetFresnel(0.2, 0.3) > wetFresnel(0.6, 0.3));
});

test('wetShininess: 粗糙度越大高光越散（单调递减），两端等于常量', () => {
  assertClose(wetShininess(0), WET_SHININESS.max, 1e-9);
  assertClose(wetShininess(1), WET_SHININESS.min, 1e-9);
  assertTrue(wetShininess(0.2) > wetShininess(0.8));
});

test('skyEnvMixAt: ry 低 ⇒ 0、ry 高 ⇒ 1；粗糙 ⇒ 过渡更缓', () => {
  assertClose(skyEnvMixAt(-1, 0.1), 0, 1e-12);
  assertClose(skyEnvMixAt(1, 0.1), 1, 1e-12);
  const sharp = skyEnvMixAt(0.3, 0.05); const soft = skyEnvMixAt(0.3, 0.9);
  assertTrue(Math.abs(soft - 0.5) < Math.abs(sharp - 0.5), '粗糙时更接近中值');
});

test('puddleAllowed: 布/植被不积水，抛光/石材积水', () => {
  assertClose(puddleAllowed(WET_CLASS_PARAMS[WET_CLASS.FABRIC][2]), 0, 1e-12);
  assertClose(puddleAllowed(WET_CLASS_PARAMS[WET_CLASS.PLANT][2]), 0, 1e-12);
  assertClose(puddleAllowed(WET_CLASS_PARAMS[WET_CLASS.POLISHED][2]), 1, 1e-12);
  assertClose(puddleAllowed(WET_CLASS_PARAMS[WET_CLASS.STONE][2]), 1, 1e-12);
});

test('wetRoughnessAt / wetSpecGainAt / wetDarkenAt: 积水处更滑更亮更暗，且都钳在合法域', () => {
  const c = WET_CLASS.STONE;
  assertTrue(wetRoughnessAt(c, 1, 1) < wetRoughnessAt(c, 1, 0));
  assertTrue(wetSpecGainAt(c, 1) > wetSpecGainAt(c, 0));
  assertTrue(wetDarkenAt(c, 1) < wetDarkenAt(c, 0));
  assertTrue(wetSpecGainAt(WET_CLASS.POLISHED, 1) <= 1);
  assertTrue(wetRoughnessAt(WET_CLASS.FABRIC, 0, 0) <= 1);
});
```

`assertClose` 与 `assertDeepEqual` 若 `assert.js` 无 `assertClose`，在本文件内定义局部 helper（同 `test-storm-rain.js` 手法）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: import 失败 `Cannot find module '../render/wet-surface-config.js'`。

- [ ] **Step 3: 实现 `src/render/wet-surface-config.js`**

按 Interfaces 的签名与 spec §6.1 的参数表逐项实现。`smoothstep`/`mix`/`clamp` 在本文件内写局部纯函数（three-free，不能 import three/tsl）。文件头注明「CPU 同构参考实现，TSL 侧在 `wet-surface.js`，两者公式必须一致（红线 1）」。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: 17 例全绿（Task 1 的 5 + 本 Task 的 12）。

- [ ] **Step 5: Commit**

```bash
git add src/render/wet-surface-config.js src/tests/test-wet-surface.js
git commit -m "feat(wet): 湿表面类参数表与 CPU 同构纯函数"
```

---

### Task 3: mesher 写 packed bit15–18

**Files:**
- Modify: `src/mesh/mesher.js`（新增 `WET_CLASS_SHIFT`；两条发射路径各 OR 上类位）
- Test: `src/tests/test-wet-surface.js`（追加）

**Interfaces:**
- Consumes: `registry.wetClassTable`（Task 1）
- Produces: `packed` bit15–18 = `wetClassTable[id]`；`buildSectionMesh` 的返回结构**不变**（无新字段、无新属性）

- [ ] **Step 1: 写失败测试**

```js
// 单方块 section 助手（全亮 0xF0，无邻居）—— 同 test-mesher.js 的 meshSingle 口径
function meshOne(reg, name) { /* 18³ halo，中心放 id，light 全 0xF0 */ }

test('mesher: 每个渲染通道方块的 bit15-18 === registry.wetClassTable', () => {
  for (const def of BLOCKS) {
    if (def.cullMode !== 'opaque' && def.cullMode !== 'cutout') continue;
    const r = meshOne(REG, def.name);
    const ch = r[def.cullMode];
    assertTrue(ch.vertexCount > 0, `${def.name} 有顶点`);
    const want = REG.wetClassTable[REG.idOf(def.name)];
    for (let i = 0; i < ch.vertexCount; i++) {
      assertEqual((ch.packed[i] >>> 15) & 0xF, want, `${def.name} vert${i} 类位`);
    }
  }
});

test('mesher: 类位不污染 bit0-14（低 15 位与「类位清零后」逐位相同）', () => {
  // 判据不依赖第二份实现：把类位掩掉后，剩下的必须仍满足既有位段语义
  for (const name of ['cloud', 'stone', 'grass', 'hanging_lamp', 'smooth_stone']) {
    const r = meshOne(REG, name);
    const ch = r[name === 'hanging_lamp' ? 'cutout' : 'opaque'];
    for (let i = 0; i < ch.vertexCount; i++) {
      const low = ch.packed[i] & 0x7FFF;
      assertEqual(low & 0xFF, 0xF0, `${name} light 位未变`);
      assertTrue(((low >>> 10) & 0x7) <= 5, `${name} face 位仍在 0-5`);
      assertTrue(((low >>> 8) & 0x3) <= 3, `${name} AO 位合法`);
    }
  }
});

test('mesher: cloud 的类位是 0 且 bit14 仍置位（两条语义独立）', () => {
  const r = meshOne(REG, 'cloud');
  for (let i = 0; i < r.opaque.vertexCount; i++) {
    assertEqual((r.opaque.packed[i] >>> 15) & 0xF, 0);
    assertEqual((r.opaque.packed[i] >>> 14) & 1, 1);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: 新增 3 例 FAIL，报 `类位: Expected <非0>, got 0`（mesher 尚未写位；`cloud` 那条例外——它期望 0，故只跑前两例确认 RED，第三例是防回归）。

- [ ] **Step 3: 实现 mesher 写位**

`src/mesh/mesher.js`：
- 在 `SHADOW_CAST_BIT` 附近加 `const WET_CLASS_SHIFT = 15;`（注释说明 bit15–18、mask 0xF、消费方 `materials.js`）；
- `buildSectionMesh` 顶部取 `const wetClassTable = registry.wetClassTable;`；
- 逐方块算一次 `const wetClassBits = (wetClassTable[id] & 0xF) << WET_CLASS_SHIFT;`（与 `blockEmissiveBit` / `noShadowCastBit` 同一位置、同一手法）；
- 两条 `packeds.push(...)` 各 `| wetClassBits`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js,test-mesher.js`
Expected: 两文件全绿（`test-mesher.js` 的 bit13/bit14 用例是「未污染」的独立佐证）。

- [ ] **Step 5: 跑 check**

Run: `npm run check`
Expected: exit 0（红线 8：mesher 仍不 import three）。

- [ ] **Step 6: Commit**

```bash
git add src/mesh/mesher.js src/tests/test-wet-surface.js
git commit -m "feat(wet): mesher 写材质类位 packed bit15-18（零顶点字节增量）"
```

---

### Task 4: wet-surface TSL 与材质接线

**Files:**
- Create: `src/render/wet-surface.js`
- Modify: `src/render/materials.js`（换 import/调用；`wet:true` 给 opaque 与 cutout；返回 `wet` 句柄；`dayNight` 加两个天空色句柄）
- Modify: `src/render/render-world.js`（删构造参数 `wetReflect`，更新文件头注释）
- Test: `src/tests/test-wet-surface.js`（追加 uniform 形状用例）

**Interfaces:**
- Consumes: `WET_CLASS_PARAMS` 与全部常量/纯函数（Task 2）；`packed` bit15–18（Task 3）；`WATER_SURFACE_Y`（既有 `render/water-surface.js`）
- Produces:
  - `WET_SURFACE_UNIFORMS`（**不 freeze**，便于 Tier 4 单变量替换成员）：`{ uWet, uWetWaterY, uWetHorizon, uWetZenith, uWetParams }`
    - `uWet = uniform(0)`
    - `uWetWaterY = uniform(WATER_SURFACE_Y)`
    - `uWetHorizon = uniform(new THREE.Color(0x87ceeb))`
    - `uWetZenith = uniform(new THREE.Color(0x87ceeb))`
    - `uWetParams = uniformArray(WET_CLASS_PARAMS.map(p => new THREE.Vector4(...p)), 'vec4')`
  - `createWetSurfaceNode({ baseRgb, faceNormal, skyDim, sunDirection, sunColor, shadowKill }): Node<vec3>`
    （`shadowKill` 可为 null ⇒ 用 `float(1)`；其余必传）
  - `createVoxelMaterials(atlasTexture, sunLight = null)` —— **第三参数 `wetReflect` 删除**
  - 返回对象：`{ opaque, cutout, transparent, dayNight, wet: WET_SURFACE_UNIFORMS }`，
    `dayNight` 新增 `uWetHorizon` / `uWetZenith` 两项（指向同一 uniform 实例）

- [ ] **Step 1: 写失败测试**

```js
test('wet uniforms: 句柄形状与初值（uWet=0 是零回归锚点）', async () => {
  const { WET_SURFACE_UNIFORMS: U } = await import('../render/wet-surface.js');
  assertEqual(U.uWet.value, 0, 'uWet 初值 0 ⇒ 未接线逐位等于原材质');
  assertTrue(Number.isFinite(U.uWetWaterY.value), '水下门基准是有限数');
  assertEqual(U.uWetParams.array.length, WET_CLASS_COUNT);
  for (let i = 0; i < WET_CLASS_COUNT; i++) {
    const v = U.uWetParams.array[i];
    assertClose(v.x, WET_CLASS_PARAMS[i][0], 1e-6, `类 ${i} wetGain`);
    assertClose(v.y, WET_CLASS_PARAMS[i][1], 1e-6, `类 ${i} darken`);
    assertClose(v.z, WET_CLASS_PARAMS[i][2], 1e-6, `类 ${i} rough`);
    assertClose(v.w, WET_CLASS_PARAMS[i][3], 1e-6, `类 ${i} specGain`);
  }
});

test('wet uniforms: 天空色句柄是 Color（片元要显式拆分量，vec3(Color) 在 WebGPU 输出黑）', async () => {
  const { WET_SURFACE_UNIFORMS: U } = await import('../render/wet-surface.js');
  for (const u of [U.uWetHorizon, U.uWetZenith]) {
    assertTrue(typeof u.value.r === 'number' && typeof u.value.set === 'function');
  }
});
```

⚠️ 本文件在 Node 白名单里，而 `wet-surface.js` import three/tsl —— Node 侧有 `tools/three-resolver.mjs` 映射（`test-storm-rain.js` 已有同类 import 的先例？若无，见 Step 2 的裁定）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: import 失败 `Cannot find module '../render/wet-surface.js'`。
若 three/tsl 在 Node 下解析失败（`uniformArray` 等 TSL 导出不可用），**裁定**：把这两条 uniform 形状用例移到 `tests/wet-surface.spec.mjs`（Tier 4，浏览器内 import），Node 侧只留纯函数用例；在 ledger 记 `Ruling`。

- [ ] **Step 3: 实现 `src/render/wet-surface.js`**

按 spec §6.2/§6.3/§6.4 实现。要点（签名与常量已定，body 由公式确定）：
- 顶点：`const cls = packed.shiftRight(15).bitAnd(15);` → `varying(vertexStage(U.uWetParams.element(cls)), 'vWetParams')`。
  ⚠️ `packed` 属性节点在 `materials.js` 已有 —— 通过参数传入还是本模块自建？**本模块自建** `attribute('packed','uint')`（three 按名字绑定，同一属性两处 `attribute()` 调用是合法的，`materials.js` 与 `block-color` 已有同类先例）。
- 片元：逐字按 spec §6.4 的伪代码，全部用 TSL 节点方法；`skyEnv` 用 `vec3(U.uWetHorizon.r, .g, .b)` 显式拆分量。
- 末尾 `return mix(baseRgb, lit, U.uWet);`

- [ ] **Step 4: 实现 materials 接线**

`src/render/materials.js`：
- import 换成 `createWetSurfaceNode, WET_SURFACE_UNIFORMS`；
- `createVoxelMaterials(atlasTexture, sunLight = null)`（删第三参数）；
- `makeMaterial` 的 `wet` 分支调用 `createWetSurfaceNode({ baseRgb: rgb, faceNormal: faceNormalNode, skyDim: uSkyDim, sunDirection: uSunDirection, sunColor: uSunColor, shadowKill })`；
- `opaque: makeMaterial({ wet: true })`、`cutout: makeMaterial({ alphaTest: 0.3, side: FrontSide, emissive: true, wet: true })`；
- `dayNight` 加 `uWetHorizon: WET_SURFACE_UNIFORMS.uWetHorizon, uWetZenith: WET_SURFACE_UNIFORMS.uWetZenith`；
- `wet: WET_SURFACE_UNIFORMS`。

`src/render/render-world.js`：构造签名去掉 `wetReflect`，`createVoxelMaterials(atlasTexture, sunLight)`；文件头与构造函数注释里关于「不得新建第二个 reflector」的段落改为「湿表面不采样任何 RT」。

- [ ] **Step 5: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: 全绿（或按 Step 2 裁定后的集合全绿）。
Run: `npm run check`
Expected: exit 0。

- [ ] **Step 6: 真页面启动烟测（TSL 编译只有真 GPU 能验）**

Run: `npx playwright test tests/render-world.spec.mjs`
Expected: 全绿且无 console 错误 —— 这条 spec 走真实 `RenderWorld` + 三通道材质编译。
若报 varying 超限或 `No stack defined`，按 spec §10 的退路改成 float varying + 片元查表，并记 `Ruling`。

- [ ] **Step 7: Commit**

```bash
git add src/render/wet-surface.js src/render/materials.js src/render/render-world.js src/tests/test-wet-surface.js
git commit -m "feat(wet): 按材质分类的湿表面 TSL（有界天空反光 + 弱太阳高光 + 积水斑）"
```

---

### Task 5: DayNight 写天空色 uniform

**Files:**
- Modify: `src/render/daynight.js`（`_apply` 末尾写两个句柄）
- Test: `src/tests/test-wet-surface.js`（追加）

**Interfaces:**
- Consumes: `dayNight.uWetHorizon` / `dayNight.uWetZenith`（Task 4）
- Produces: `_apply(p)` 写 `uWetHorizon.value.set(...p.fogColor 的 RGB)`、`uWetZenith.value.set(...p.sky 的 RGB)`；句柄缺失跳过

- [ ] **Step 1: 写失败测试**

```js
test('DayNight: _apply 把风格天空色写给湿表面（首帧即生效，句柄缺失不抛错）', async () => {
  const { DayNight, VISUAL_STYLES } = await import('../render/daynight.js');
  const seen = { h: null, z: null };
  const mk = () => ({ value: { r: 0, g: 0, b: 0, set(r, g, b) { this.r = r; this.g = g; this.b = b; } } });
  const h = mk(); const z = mk();
  const dn = new DayNight({
    scene: {}, fog: { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } },
    voxelUniforms: {
      uSkyDim: { value: 0 }, uBlockBoost: { value: 0 }, uShadowStrength: { value: 0 },
      uWetHorizon: h, uWetZenith: z,
    },
    visualStyle: 'dusk',
  });
  // dusk 的 sky/fogColor 不同色 ⇒ 能区分两个句柄没接反
  const d = VISUAL_STYLES.dusk;
  assertTrue(h.value.r !== z.value.r || h.value.b !== z.value.b, '两句柄不得写成同一个色');
  // 句柄缺失的既有调用方不得抛错
  new DayNight({
    scene: {}, fog: { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } },
    voxelUniforms: { uSkyDim: { value: 0 }, uBlockBoost: { value: 0 }, uShadowStrength: { value: 0 } },
  });
});
```

⚠️ 断言要钉**具体值**而不是「不同」：用 `THREE.Color` 的 sRGB→线性口径算期望值不现实（Node 侧无 three Color），故改为**钉写入次数与顺序**：`h` 记录最后一次写入的三元组，与 `dn.fog.fogColor.value.set` 收到的三元组**逐位相同**；`z` 与 `scene.background.set` 收到的相同。用 stub 捕获这两处的入参作为**独立真值**（不重算 Color 转换）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: 新例 FAIL（`_apply` 尚未写这两个句柄 ⇒ `h.value` 仍全 0，与 fogColor 入参不等）。

- [ ] **Step 3: 实现**

`src/render/daynight.js` 的 `_apply`：在既有 `uAmbientColor` 写入之后加两段，
用 `.value.set(r,g,b)`（Color 有 `set`；**不用 `setRGB` 之外的方法名**——Color 两者都有，但既有注释记过 Vector3 只有 `set` 的坑，这里统一用 `set`）。
色值来源：`p.fogColor` / `p.sky` 是 **hex number**，而句柄是 Color ⇒ 用 `u.value.set(p.fogColor)`（`Color.set(hex)` 合法，与 `this.fog.fogColor.value.set(p.fogColor)` 逐字同手法）。
句柄缺失（`undefined`）时跳过。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js,test-daynight.js`
Expected: 两文件全绿（`test-daynight.js` 的既有 stub 不带新句柄 ⇒ 验容错）。

- [ ] **Step 5: Commit**

```bash
git add src/render/daynight.js src/tests/test-wet-surface.js
git commit -m "feat(wet): 日夜风格把天空色写给湿表面反光（复用既有权威）"
```

---

### Task 6: 拆除后处理链与第二条反射 pass（含删 7 文件）

**Files:**
- Delete（用户已确认）: `src/render/wet-ground.js`、`src/render/wet-ground-config.js`、`src/render/ground-reflect.js`、`src/render/ground-reflect-config.js`、`src/render/storm-grade.js`、`src/render/storm-grade-config.js`、`src/tests/test-ground-reflect.js`
- Modify: `src/core/game.js`、`src/render/ocean.js`、`src/ui/settings-panel.js`（注释）、`src/tests/test-storm-rain.js`、`src/tests/index.html`、`tools/test-tiers.mjs`
- Test: `src/tests/test-storm-rain.js`（改：删两段 import 与对应用例，加「被删模块真的不存在」断言）

**Interfaces:**
- Consumes: `WET_STRENGTH_MAX`（Task 2，**同名同值**，从 `wet-surface-config.js` 导入）、`materials.wet.uWet`（Task 4，句柄名不变）
- Produces: `Game` 不再有 `groundReflect` / `stormGrade` / `_groundReflectPlaceholder` / `_groundMirrorY` / `_groundReflectFrame` / `_groundReflectLast` / `_lastGroundDt` / `_wetReflectWired` / `_renderGroundReflection` / `_stormReflectVisible`；`ocean` 不再有 `reflectMatrix` / `setWetReflectNode` / `setWetReflectMatrix`

- [ ] **Step 1: 写失败测试**

`src/tests/test-storm-rain.js`：删掉 `wet-ground-config.js` 与 `storm-grade-config.js` 两段 import 及消费它们的全部用例；新增：

```js
test('storm: 上游湿地面与后处理链已整体移除（不得凭直觉补齐）', async () => {
  for (const p of ['wet-ground.js', 'wet-ground-config.js', 'ground-reflect.js',
    'ground-reflect-config.js', 'storm-grade.js', 'storm-grade-config.js']) {
    let ok = false;
    try { await import(`../render/${p}`); } catch { ok = true; }
    assertTrue(ok, `${p} 必须已删除`);
  }
});

test('storm: WET_STRENGTH_MAX 由新 config 提供且仍为 1.0（句柄语义不变）', async () => {
  const { WET_STRENGTH_MAX } = await import('../render/wet-surface-config.js');
  assertClose(WET_STRENGTH_MAX, 1.0, 1e-12);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-storm-rain.js`
Expected: 「已整体移除」用例 FAIL（6 个文件都还在）。

- [ ] **Step 3: 备份并删除 7 个文件**

先逐条 `cp` 到 `/tmp/mc-heavy-wet-removal-backup/`（本 session 创建的目录，`mkdir -p` 后用字面路径），
再逐条 `rm` **字面路径**（不用通配符）。删完 `ls` 确认 7 个都不在。

- [ ] **Step 4: 改 `src/core/game.js`**

- 删 import：`createStormGrade`、`WET_STRENGTH_MAX from wet-ground-config`、`setupGroundReflect/createGroundReflectPlaceholderMaterial`、`ground-reflect-config` 整段、`blocksRain`（唯一消费方是被删的 `_renderGroundReflection`）；
- 加 import：`WET_STRENGTH_MAX from '../render/wet-surface-config.js'`；
- 删 `this.groundReflect` 装配段（:519–524）、`wetReflect:` 构造项、`_wetReflectWired`、`setMatrixTarget`/`uWetReflect` 那个 block；
- 删 `_lastGroundDt` 赋值（:1490）；
- 渲染分支改回 `this.renderer.render(this.scene, this.camera);`（删 pipeline 分支与注释）；
- `_renderWaterReflection`：`gateVisible` 回到 `visible`，`tick(visible && fade > 0.001)`，删末尾 `this._renderGroundReflection(hidden)`；
- 删 `_renderGroundReflection` 与 `_stormReflectVisible` 两个方法整体；
- `setStormLighting`：删「③ 后处理链」整段，`wet.uWet.value = on ? WET_STRENGTH_MAX : 0` 保留；
- `_updateStorm`：删 `wet.uWetTime` 与 `stormGrade.uniforms.uTime` 两行（新模型无时钟），保留 `uWet` 的室内门；
- `dispose`：删 `groundReflect` / `_groundReflectPlaceholder` / `stormGrade` 三行；
- 方法头注释更新为「开启 = 持续雨 + 按材质分类的湿表面 + 雨声；关闭逐位回到改动前」。

- [ ] **Step 5: 改 `src/render/ocean.js`**

删 `_wetPlaceholder` / `placeholderTexture()` / `REFLECT_BIAS`（唯一消费方是被删的 wet 矩阵写入）/ `reflectMatrix` 返回项 / `setWetReflectNode` / `setWetReflectMatrix`；
`renderReflection` 内删占位图切换的 try/finally 嵌套与 `vc` 矩阵写入段，恢复为「藏 hidden → `reflectUpdate` → finally 恢复」。
⚠️ **`reflectNode.clone()`（`reflectTexture` 返回项）保留**——它是 v3.30 之前就有的公开句柄，删它属超范围。

- [ ] **Step 6: 改注册与分档**

`src/tests/index.html` 删 `import './test-ground-reflect.js';`；
`tools/test-tiers.mjs` 的 `UNIT_NODE_SAFE` 删 `'test-ground-reflect.js'`。
`src/ui/settings-panel.js` 的 `_rowStormLighting` 注释改为「持续下雨 + 按材质分类的湿表面反光 + 上游雨声床」（文案与落位不动）。

- [ ] **Step 7: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-storm-rain.js,test-wet-surface.js,test-rain-shelter.js,test-water-surface.js`
Expected: 四文件全绿。
Run: `npm run check`
Expected: exit 0（`[测试注册]`/`[测试分档]` 双向一致；无死引用）。

- [ ] **Step 8: 真页面回归（雨与水面）**

Run: `npx playwright test tests/storm-audio-off.spec.mjs tests/water-visual.spec.mjs tests/water-reflect.spec.mjs`
Expected: 全绿。水面冻结色阶预期**逐位回到基线**（反射段回到 v3.30 之前）。
⚠️ `tests/storm-lighting.spec.mjs` / `storm-rain-visual` / `storm-underwater` / `carbine-flash-wet` 此刻仍引用被删 API ⇒ **本 Task 不跑它们**，Task 7 修完再跑。

- [ ] **Step 9: Commit**

```bash
git add -u src/render src/core src/tests src/ui tools/test-tiers.mjs
git commit -m "refactor(wet)!: 拆除上游湿地面/第二条反射 pass/整条后处理链"
```

---

### Task 7: Tier 4 spec 与既有 spec 修正

**Files:**
- Create: `tests/wet-surface.spec.mjs`
- Modify: `tests/storm-lighting.spec.mjs`、`tests/storm-rain-visual.spec.mjs`、`tests/storm-underwater.spec.mjs`、`tests/carbine-flash-wet.spec.mjs`
- Modify: `tools/test-tiers.mjs`（PIXEL 档加 `wet-surface`）

**Interfaces:**
- Consumes: `window.__MC_GAME__.renderWorld.materials.wet`（`uWet` / `uWetWaterY` / `uWetParams` / `uWetHorizon` / `uWetZenith`）、`g.setStormLighting`、`g.registry.wetClassTable`、`g.editor.setBlocks`
- Produces: Tier 4 回归门（spec §9.2 的 10 条）

- [ ] **Step 1: 写 `tests/wet-surface.spec.mjs` 的前 4 条并确认 RED**

先只写「云与岩壁零光晕」这一条（spec §9.2 #1），机位与冻结口径逐字照 `tests/storm-underwater.spec.mjs` 的 `BOOT` + `waitWorldStable`。
夹具：在玩家所在列上空 `y=P+1..P+3` 造 x 方向石墙、`y=P` 铺石地面、`y=P+12` 造 5×5 云簇（`cloud`），清空其余；相机摆到能同时看到三者的位置。
单变量 `uWet` 0↔1，量三个区域的变化像素占比。

Run: `MC_ALLOW_TMP= npx playwright test tests/wet-surface.spec.mjs`
Expected: **PASS**（此时实现已在 Task 4 落地）—— 故 RED 必须靠**负向注入**取得：先用 `page.route` 把 `wet-material-data.js` 里 `cloud` 改成 `STONE`（goto 之前注册），跑同一用例 ⇒ Expected: **FAIL**（云区变化占比超 0.02）。这一步就是 spec §9.2 #8。
⚠️ 注入后读回源码确认落地；`page.route` 注入不落盘，无需还原文件。

- [ ] **Step 2: 补齐其余用例**

按 spec §9.2 的 #2 / #2b / #3 / #4 / #5 / #6 / #7 / #9 逐条写。
- #2 改 `uWetParams.array[i]` 的 `Vector4` 分量（`uWetParams` 的 `updateType=RENDER` ⇒ 每帧自动重传，无需 `needsUpdate`）；
- #5 **同一 page 内**把 `uWet` 从 1 写回 0 与基线比（不跨 page）；
- #9 用 `page.route` 把 `wet-surface.js` 的 `mix(albedo, skyEnv, reflK)` 换成 `add(albedo, skyEnv.mul(reflK))` ⇒ #4 必须 FAIL。

- [ ] **Step 3: 跑新 spec 全绿**

Run: `npx playwright test tests/wet-surface.spec.mjs`
Expected: 全部用例 PASS，`errs` 为空。

- [ ] **Step 4: 修既有 4 个 spec**

- `storm-lighting.spec.mjs`：删 `gradeEnabled` / `hasPipeline` 断言；最后一条用例改名为「性能档雨丝减半」并删 bloom 部分与 `storm-grade-config` 的 import。
- `storm-rain-visual.spec.mjs`：重写为 3 条（雨丝上屏差分 / 中心天空区不撕碎 / 关闭零回归），删竖纹、世界锚定雾、湿地面近中远三条与 `rowFlipRate` helper。
- `storm-underwater.spec.mjs`：删两条颗粒用例与 `grainStats`/`measureGrain`/`colTimeStd` helper 及 `freezeForGrain`；湿地面水下用例去掉 `groundReflect.mirrorY` 与 `stormGrade.pipeline.render()`（改 `g.renderer.render(g.scene, g.camera)`），`uWetWaterY` 名不变；负向用例里对 `storm-grade.js` 的 route 一并删。
- `carbine-flash-wet.spec.mjs`：删两条湿地面用例（火光两条保留）。

- [ ] **Step 5: 分档注册 + check**

`tools/test-tiers.mjs` 的 `PIXEL` 加 `'wet-surface'`。
Run: `npm run check`
Expected: exit 0（`[测试分档] spec N / 单测 M 双向钉住`）。

- [ ] **Step 6: 跑全部相关 spec**

Run: `npx playwright test tests/wet-surface.spec.mjs tests/storm-lighting.spec.mjs tests/storm-rain-visual.spec.mjs tests/storm-underwater.spec.mjs tests/carbine-flash-wet.spec.mjs tests/storm-audio-off.spec.mjs tests/render-world.spec.mjs tests/light-mesh-sync.spec.mjs tests/m3-fullscene.spec.mjs tests/atlas.spec.mjs tests/unit-fast.spec.mjs`
Expected: 全绿。`m3-fullscene` 的 `gpuVertexBytes` 必须仍是 **193.83 MiB** 量级（逐位不变）。
⚠️ 预计 >1 分钟 ⇒ 用 `run_in_background`，不接管道。

- [ ] **Step 7: Commit**

```bash
git add tests/wet-surface.spec.mjs tests/storm-lighting.spec.mjs tests/storm-rain-visual.spec.mjs tests/storm-underwater.spec.mjs tests/carbine-flash-wet.spec.mjs tools/test-tiers.mjs
git commit -m "test(wet): 湿表面 Tier 4 像素门（含两条负向注入）与既有雨天 spec 修正"
```

---

### Task 8: 反光量级标定与文档

**Files:**
- Modify: `src/render/wet-surface-config.js`（按实测调旋钮）
- Modify: `tests/wet-surface.spec.mjs`（#2b 的带若需重标，**先停下报告**）
- Modify: `docs/roadmap.md`（v3.31 行）、`docs/pitfalls.md`（新节）

**Interfaces:**
- Consumes: Task 7 的 #2b 用例读数
- Produces: 标定后的常量 + 文档

- [ ] **Step 1: 读 #2b 的实测读数**

Run: `npx playwright test tests/wet-surface.spec.mjs -g "量级"`
Expected: 打印 `smooth_stone` 与 `grass` 的 Δluma。若 `smooth_stone` 的 Δluma < 6 ⇒ 进 Step 2；若已在 [6,40] 且 grass < stone/2 ⇒ 跳到 Step 3。

- [ ] **Step 2: 按 spec §6.1b 的顺序扇描（每次只动一个旋钮）**

顺序：`WET_REFL_MAX` 0.55→0.75→0.90 → 菲涅尔幂 5→3 → `F0` 基数。
每档跑一次 #2b，记读数。取**第一个**让 `smooth_stone ∈ [6,40]` 且 `grass < stone/2` 的档位。
⚠️ 若三个旋钮全部试完仍不入带 ⇒ **停下报告**，不放宽判据。

- [ ] **Step 3: 跑 bench 回归（碰了 materials/mesher 热路径）**

Run: `npm run bench -- --check`
Expected: exit 0。若 frameP95 越线，按既有口径用**交替对照**判定（不看单次红绿），不改阈值。
⚠️ 用 `run_in_background`（~5min）。

- [ ] **Step 4: 写文档**

`docs/roadmap.md` 加 v3.31 行：用户裁定、根因三条（侧面 wet 0.85 / 竖直拉伸 12.2× / 云吃满强度 + 屏幕空间雾）、方案（packed bit15–18 零内存增量、九类材质、有界 mix）、删了什么、实测读数、验证命令与结果。
`docs/pitfalls.md` 加节「上游独立地面 mesh 的 shader 不能挂到体素通道」：记三条错配与「新增顶点属性会超内存门」的实测数字，以及「分类进 packed 空闲位」的正解。

- [ ] **Step 5: 全套里程碑门**

改了 `src/tests/index.html` 注册 ⇒ 命中 AGENTS.md 的「全局基础设施」⇒ 收尾跑一次全套。
Run: `npm test`
Expected: 记录实际结果。既有 flaky（`m3-rain` 截图差分、`cinder-fall`/`storm-lance` 噪声底、`about-tab` 文案）若红，按既有口径**交替对照**定性，不改阈值，在报告里逐条点名。
⚠️ 用 `run_in_background`（分钟级到十几分钟级）。

- [ ] **Step 6: Commit**

```bash
git add src/render/wet-surface-config.js tests/wet-surface.spec.mjs docs/roadmap.md docs/pitfalls.md
git commit -m "docs(wet): v3.31 标定读数与坑目录；反光量级按实测定档"
```

---

## Self-Review

**1. Spec coverage**：§2.3 内存约束 → Global Constraints + Task 3 Step 1；§5 分类表 → Task 1；§6.1/6.1b 参数与标定 → Task 2 + Task 8；§6.2 uniform → Task 4 Step 1；§6.3 顶点 varying → Task 4 Step 3/6；§6.4 片元 → Task 4 Step 3；§6.5 纯函数 → Task 2；§7 已知近似 → 无需实现（写进文档，Task 8）；§8.1 删除 → Task 6 Step 3；§8.2 新建 → Task 1/2/4/7；§8.3 修改 17 项 → Task 1(3)/3(1)/4(2)/5(1)/6(6)/7(5)/8(2) 全覆盖；§9.1 九条 → Task 1(5 例)+2(12 例)+3(3 例)；§9.2 十条 → Task 7；§9.3 回归 → Task 6 Step 8 + Task 7 Step 6 + Task 8 Step 3/5；§9.4 冻结数字 → Global Constraints + Task 7 Step 6。**无缺口**。

**2. Step scan**：每个 code step 给了签名/文件/常量来源，body 由公式或既有手法确定。Task 5 Step 1 的断言原先写「两句柄不同色」——那是弱判据（写成同一个错色也可能不同），已改为「与 fogColor/background 收到的入参逐位相同」的独立真值。Task 7 Step 1 的 RED 靠负向注入取得（实现先于 spec 落地，这是拆除重写的必然顺序），已写明。

**3. Type consistency**：`WET_CLASS_PARAMS` 是数组的数组（Task 2）→ `uniformArray(...map(p => new Vector4(...p)))`（Task 4）一致；`wetnessAt(strength, up, cls, worldY, waterY)` 参数序在 Task 2 定义与测试调用一致；`materials.wet.uWet` / `uWetWaterY` 句柄名在 Task 4 产出与 Task 6/7 消费一致；`WET_STRENGTH_MAX` 从旧 config 迁到新 config，名与值不变。

**4. Review Focus**：五条各有归属 Task 的测试（见该节）。

**5. Proportion**：8 个 Task，代码块只出现在测试断言与两处易错接线；其余是签名 + 常量来源 + 命令。计划长度约为 spec 的 0.9 倍，不是代码转录。