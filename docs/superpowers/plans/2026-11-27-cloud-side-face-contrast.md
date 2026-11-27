# 云侧面 / 顶底面明暗分离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 cloud 方块的四个侧面比顶面/底面更亮更白，使逆光仰视时能分辨出一片片云朵（侧/底屏幕比从 1.000 抬到 ≥1.15）。

**Architecture:** 在 `materials.js` 的最终 shade 上乘一个逐面类别的**灰阶** gain（侧 1.38 / 顶 0.95 / 底 0.72），面类别由已有的 `faceNormalNode.y` 判，不新增顶点属性、不改 mesher。gain 由新的独立 uniform `uCloudFaceContrast` 门控（0 ⇒ 逐位回到 v3.50），常量与 CPU 参考实现落在 three-free 的 `cloud-shade.js`。

**Tech Stack:** three r185.1 TSL（WebGPU 唯一后端）、Node v26 原生单测、Playwright + pngjs 像素门。

**Spec:** `docs/superpowers/specs/2026-11-27-cloud-side-face-contrast-design.md`

## Global Constraints

- 依赖方向 `voxel ← gen ← mesh ← render`；`cloud-shade.js` **零 import**（避免 daynight ↔ sun-shade 循环初始化）。
- 红线 1：TSL 与 CPU 参考实现共用同一份常量/公式，不各写字面量。
- 红线 11：shade 在**顶点阶段**算成 float 经 float varying 传片元。
- TSL 七条口径：不与裸数字算术（一律 `.mul()/.add()`）、不用 `.toVar()/.assign()`、mix/select 嵌套不链式、`mix` 而非 `if`。
- 幅度**冻结为批准值**：`CLOUD_SIDE_FACE_GAIN = 1.38` / `CLOUD_TOP_FACE_GAIN = 0.95` / `CLOUD_BOTTOM_FACE_GAIN = 0.72`。
- 灰阶：gain 是标量，乘整个 vec3（等比缩放保色相）。
- 只做 `cloud` 本体；不改 mesher / daynight / blocks-data；零烘焙产物改动。
- 测试命令**不接管道**；预计 >1 分钟的用 `run_in_background`。
- 浏览器验证在 worktree 里必须 `MC_PORT=<自己的端口>` 两侧同源并核对端口归属。
- 负向注入用 `edit` + 读回确认，还原用 `cp` 副本，**不用 `git checkout`**。
- 提交必须等明确指令（本计划的 commit 步骤在用户下令后才执行）。

## Review Focus

1. **削顶**：侧 gain 调大到 1.42 时 dusk +Z 面线性 1.0133 > 1 ⇒ ACES 钳平三通道、色相消失。Task 1 的扫描断言钉住。
2. **色相被抹**：gain 若逐通道不同值（或加 `min(v,1)` cap），night +Z 的 R−B 从 −32.4 变 0。Task 1 保色相用例 + Task 4 负向②钉住。
3. **非云方块被波及**：gain 若漏掉 `cloudBit` 门控，整个 opaque 通道（石头/雪/树叶）都变亮。Task 2 源码断言 + Task 3 判据④钉住。
4. **单变量失效**：若复用 `uCloudSoften` 做 A/B，=0 会同时关掉 v3.50 三个地板 ⇒ 对照不成立。Task 1 零回归用例 + Task 2 独立 uniform 断言钉住。
5. **只乘 sky 项**：火把照亮的云面（blocklight 胜出的 quad）不参与面间对比 ⇒ 夜里云面又糊在一起。Task 2 两处 shade 断言钉住。

---

### Task 1: `cloud-shade.js` 面类别 gain 的常量与纯函数

**Files:**
- Modify: `src/render/cloud-shade.js`（新增常量与 `cloudFaceGainFor`；`cloudShadeFor` 加可选入参）
- Test: `src/tests/test-cloud-shade.js`（追加用例，既有用例不动）

**Interfaces:**
- Consumes: 既有 `CLOUD_FACE_NORMALS`（模块内私有，序同 `FACE_NORMALS`：+X,−X,+Y,−Y,+Z,−Z）、`aoFactorFor`、`cloudSunFloorFor`、`cloudHemiFloorFor`、`cloudAoFloorFor`。
- Produces:
  - `CLOUD_SIDE_FACE_GAIN: number = 1.38`、`CLOUD_TOP_FACE_GAIN: number = 0.95`、`CLOUD_BOTTOM_FACE_GAIN: number = 0.72`
  - `cloudFaceGainFor(normalIndex: number, contrast?: number = 1): number`
  - `cloudShadeFor({..., faceContrast?: number = 0 }): number`（新增可选键，缺省 0 = 现有行为）

- [ ] **Step 1: 写失败测试 —— gain 的零回归与分档值**

在 `src/tests/test-cloud-shade.js` 末尾追加（import 补 `CLOUD_SIDE_FACE_GAIN, CLOUD_TOP_FACE_GAIN, CLOUD_BOTTOM_FACE_GAIN, cloudFaceGainFor`）：

```js
test('cloud-face-gain: contrast=0 时六面 gain 逐位 1（零回归锚点）', () => {
  for (let n = 0; n < 6; n++) assertEqual(cloudFaceGainFor(n, 0), 1, `面 ${n}`);
});

test('cloud-face-gain: contrast=1 时四侧面 1.38 / 顶 0.95 / 底 0.72', () => {
  for (const n of [0, 1, 4, 5]) assertEqual(cloudFaceGainFor(n, 1), CLOUD_SIDE_FACE_GAIN, `侧面 ${n}`);
  assertEqual(cloudFaceGainFor(2, 1), CLOUD_TOP_FACE_GAIN, '顶面');
  assertEqual(cloudFaceGainFor(3, 1), CLOUD_BOTTOM_FACE_GAIN, '底面');
  assertEqual(CLOUD_SIDE_FACE_GAIN, 1.38, '批准幅度');
  assertEqual(CLOUD_TOP_FACE_GAIN, 0.95, '批准幅度');
  assertEqual(CLOUD_BOTTOM_FACE_GAIN, 0.72, '批准幅度');
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs src/tests/test-cloud-shade.js`
Expected: FAIL —— `cloudFaceGainFor is not a function` / 常量 undefined（不是语法错）。

- [ ] **Step 3: 写失败测试 —— 侧/底比、削顶上界、保色相**

同一文件继续追加三条。判据用独立参考实现算屏幕值（`srgbEncode(acesFilmic(...))` 从 `sun-shade.js` import，已存在）：

```js
test('cloud-face-gain: 五档侧/底屏幕比 ≥1.15，且侧亮/顶暗/底暗同时成立', () => {
  // 五档参数取自 VISUAL_STYLES（import daynight.js），缺省回落全局常量
  // 对 ao ∈ {1,3}：sideScreen/botScreen ≥ 1.15；sideOn > sideOff；topOn < topOff；botOn < botOff
});

test('cloud-face-gain: 全档全面最大线性 <1.0（不削顶），且侧 gain 1.42 时该扫描 >1', () => {
  // 5 档 × 6 面 × 4 AO 扫最大线性；断言 <1.0（实测 0.9848）
  // 判别力：把侧 gain 换成 1.42 重扫，断言 >1.0（实测 1.0133）
});

test('cloud-face-gain: 非中性色温档底面 R−B 符号不变且偏移 <8 灰阶', () => {
  // dusk/night/normal：逐通道算 shade（地板用 cloudSunFloorRGBFor），
  // 断言 sign(R−B) 不变、|Δ(R−B)| < 8
});
```

三条的具体循环体由实施者按 §4.4 的口径写；**断言值用 spec 的实测数**（1.15 / 1.0 / 1.42 / 8）。

- [ ] **Step 4: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs src/tests/test-cloud-shade.js`
Expected: FAIL —— 三条新用例都因 `cloudFaceGainFor` 缺失或 `faceContrast` 未接线而红。

- [ ] **Step 5: 实现常量与 `cloudFaceGainFor`**

在 `cloud-shade.js` 的三个 lift 常量之后加三个 gain 常量（各带一行中文注释说明职责）；
在 `cloudAoFloorFor` 之后加：

```js
export function cloudFaceGainFor(normalIndex, contrast = 1) {
  const ny = CLOUD_FACE_NORMALS[normalIndex][1];
  const k = ny > 0.5 ? CLOUD_TOP_FACE_GAIN
    : ny < -0.5 ? CLOUD_BOTTOM_FACE_GAIN : CLOUD_SIDE_FACE_GAIN;
  return 1 + (k - 1) * contrast;
}
```

⚠️ 写成 `1 + (k−1)×contrast` 而非 `contrast ? k : 1`：与 TSL 的 `mix(1, k, t)` 同形，
保 `contrast=0` 的逐位性两侧同源（同 v3.50 三个地板的口径）。

`CLOUD_FACE_NORMALS` 定义在文件末尾（`const` 不提升但函数调用时已初始化）—— 若新函数放在它之前，
确认调用时机在模块求值之后（既有 `cloudShadeFor` 已是这个形态）。

- [ ] **Step 6: `cloudShadeFor` 接 `faceContrast`**

签名加 `faceContrast = 0`，jsdoc 补一行；返回式末尾乘 `cloudFaceGainFor(normalIndex, faceContrast)`。
**缺省 0** ⇒ 既有 7 组不变式与 7776 组零回归用例逐位不动。

- [ ] **Step 7: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs src/tests/test-cloud-shade.js`
Expected: PASS，既有 12 例 + 新增 5 例全绿，输出无 warning。

- [ ] **Step 8: 跑 Node 轻档全量确认无连带红**

Run: `npm run test:unit`
Expected: 全绿（本步只改纯函数，消费方只有 materials.js 尚未接线）。

---

### Task 2: `materials.js` 的面类别 gain 与独立 uniform

**Files:**
- Modify: `src/render/materials.js`（`CLOUD_SURFACE_UNIFORMS` 加一项；gain 节点；两处 shade 相乘；透出句柄）
- Test: `src/tests/test-cloud-shade.js`（追加源码级接线断言 + uniform 句柄断言）

**Interfaces:**
- Consumes: Task 1 的 `CLOUD_SIDE_FACE_GAIN / CLOUD_TOP_FACE_GAIN / CLOUD_BOTTOM_FACE_GAIN`；既有 `faceNormalNode`、`cloudBit`、`shadeLit`、`shadeUnlit`、`select`、`mix`、`float`、`mul`。
- Produces: `CLOUD_SURFACE_UNIFORMS.uCloudFaceContrast`（uniform，初值 1.0）；`createVoxelMaterials().dayNight.uCloudFaceContrast` 与 `.cloud.uCloudFaceContrast` 指向同一实例。

- [ ] **Step 1: 写失败的源码级断言**

追加到 `test-cloud-shade.js`（用既有 `codeOf` helper，它已滤掉注释行）：

```js
test('materials: 面类别 gain 由 cloudBit × uCloudFaceContrast 门控，且乘在 shadeLit/shadeUnlit 两处', async () => {
  const code = await codeOf('../render/materials.js');
  assertTrue(/uCloudFaceContrast:\s*uniform\(1\.0\)/.test(code), '必须有初值 1.0 的独立 uniform');
  assertTrue(/const cloudFaceGain = mix\(float\(1\),\s*cloudFaceK,\s*mul\(cloudBit,\s*uCloudFaceContrast\)\)/.test(code),
    'gain 必须是 mix(1, faceK, cloudBit × uCloudFaceContrast)');
  assertTrue(/const shadeLit = mul\(max\(.*\),\s*cloudFaceGain\)/.test(code), 'shadeLit 必须乘 gain');
  assertTrue(/const shadeUnlit = mul\(max\(.*\),\s*cloudFaceGain\)/.test(code), 'shadeUnlit 必须乘 gain');
  assertTrue(!/if\s*\(\s*cloudFaceContrast/.test(code), '不得用 if 分支');
});

test('materials: gain 是标量（灰阶）且三个常量从 cloud-shade import', async () => {
  const code = await codeOf('../render/materials.js');
  assertTrue(/CLOUD_SIDE_FACE_GAIN/.test(code) && /CLOUD_TOP_FACE_GAIN/.test(code) && /CLOUD_BOTTOM_FACE_GAIN/.test(code),
    '三个 gain 常量必须 import，不得写字面量');
  assertTrue(!/vec3\(\s*CLOUD_SIDE_FACE_GAIN/.test(code), 'gain 不得是逐通道 vec3（会抹色相）');
});

test('daynight: _apply 不写 uCloudFaceContrast（与 style 无关）', async () => {
  const code = await codeOf('../render/daynight.js');
  assertTrue(!/uCloudFaceContrast/.test(code), 'gain 与 style 无关，_apply 不得写它');
});

test('cloud uniforms: uCloudFaceContrast 初值 1 且句柄同一实例', async () => {
  const { CLOUD_SURFACE_UNIFORMS: U } = await import('../render/materials.js');
  assertEqual(U.uCloudFaceContrast.value, 1, '初值 1（满档面间对比）');
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs src/tests/test-cloud-shade.js`
Expected: FAIL —— 四条新断言红（uniform 与 gain 节点尚不存在）。

- [ ] **Step 3: 实现 gain 节点与两处相乘**

在 `materials.js`：
1. import 补三个 gain 常量；
2. `CLOUD_SURFACE_UNIFORMS` 加 `uCloudFaceContrast: uniform(1.0)`（带注释：独立旋钮，0 ⇒ 逐位回 v3.50）；
3. 在 `cloudT` 定义之后加 `cloudFaceK`（两层 select，用 `faceNormalNode.y`）与 `cloudFaceGain`；
   ⚠️ `faceNormalNode` 定义在 `cloudT` **之后**（太阳项那段）⇒ gain 节点必须放在 `faceNormalNode` 之后、
   `shadeLit` 之前。实施者按实际行序放置，不要制造 TDZ。
4. `shadeLit` / `shadeUnlit` 各包一层 `mul(..., cloudFaceGain)`；
5. 返回值 `dayNight` 加 `uCloudFaceContrast`（`cloud` 句柄已指向整个 `CLOUD_SURFACE_UNIFORMS`，自动带上）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs src/tests/test-cloud-shade.js`
Expected: PASS（含 Task 1 的 5 例与本任务 4 例）。

- [ ] **Step 5: 静态门 + lint**

Run: `npm run check`
Expected: exit 0；lint 0 error（warnings 与既有基线 188 一致）。

---

### Task 3: Tier 4 侧面机位与侧/底比判据

**Files:**
- Modify: `tests/cloud-softness.spec.mjs`（加侧面机位、`uCloudFaceContrast` A/B、5 条判据）

**Interfaces:**
- Consumes: Task 2 的 `g.renderWorld.materials.cloud.uCloudFaceContrast`；既有 `buildSlabs` / `sample` / `regionLuma` / `waitWorldSettled`。
- Produces: 新 test「云面间对比：侧面变亮、底面变暗、侧/底比 ≥1.15、石头板零回归」。

- [ ] **Step 1: 加侧面机位并先打印实测值（不写断言）**

`CAMS` 加两支：`sideCloud` / `sideStone`。机位口径：相机与板同高（`pos:[0, 1, 0]` 相对 P），
水平偏移到板外侧（如 `dx: -14`），`atY: 1`，`camera.up` 用 (0,1,0)（水平视线不退化）。
⚠️ `sample()` 现在把 `camera.up` 写死 (0,0,-1)（为俯视/仰视避退化）⇒ 侧面机位必须让它按机位选 up，
否则水平视线与 up 平行会退化。改 `sample` 接受 `cam.up`，缺省仍 (0,0,-1)（既有四机位逐位不变）。

先只 `console.log` 六支读数与比值，跑一次拿到真实值。

Run（worktree 自己的端口）: `MC_PORT=8192 npx playwright test tests/cloud-softness.spec.mjs -g "面间对比"`
Expected: 打印出 sideCloud/sideStone/botCloud 的 on/off 读数；**此时还没有断言**。

- [ ] **Step 2: 按实测值写 5 条判据**

用 Step 1 的实测值定阈值（spec §6.3 的表是口径，不是最终数）：
① 侧面 on/off > 1.05；② 底面 on/off < 0.97；③ 侧/底 ≥ 1.15；
④ 石头三支 |on−off| < 1.0；⑤ sanity：各支 > 20、石头 < 185、云顶 ≈ CPU 预测 ±12。

⚠️ 不得照抄 stone 的 <185 到云上（v3.50 已踩：云顶 227 > 天空 192）。

- [ ] **Step 3: 跑测试确认 GREEN**

Run: `MC_PORT=8192 npx playwright test tests/cloud-softness.spec.mjs`
Expected: 既有 3 例 + 新增 1 例全绿（既有 3 例的 `uCloudSoften` A/B 不受本轮影响，读数应逐位不变）。

- [ ] **Step 4: 核对端口归属**

Run: `lsof -ti:8192` → `lsof -p <pid>` 看 cwd 是否本 worktree。
Expected: cwd = `/Users/bachi/jaylli/mc-heavy/.worktrees/feat/cloud-side-face-contrast`。

---

### Task 4: 负向验证两条

**Files:**
- Modify: `tests/cloud-softness.spec.mjs`（加两条负向 test，用既有 `routeModule` / `browserCode` helper）

**Interfaces:**
- Consumes: Task 3 的新判据；既有 `routeModule(page, file, transform)`（模式未命中即 throw）与 `browserCode`。

- [ ] **Step 1: 负向① —— gain 恒 1**

`routeModule` 把 `materials.js` 的 `const cloudFaceGain = mix(...)` 整行替换成 `const cloudFaceGain = float(1);`，
读回浏览器侧代码行确认落地，然后断言**侧/底比 < 1.02**（缺陷被抓到 = 本用例 PASS）。

- [ ] **Step 2: 跑负向① 确认它 PASS（即缺陷真被抓到）**

Run: `MC_PORT=8192 npx playwright test tests/cloud-softness.spec.mjs -g "负向③"`
Expected: PASS，且打印的侧/底比回到 ≈1.000。

- [ ] **Step 3: 负向② —— gain 改成带色偏**

把 `cloudFaceGain` 替换成逐通道不同的 vec3（如 `vec3(1.38, 1.0, 0.72)` 乘侧面），
断言底面或侧面的 R−B 偏移 > 8 灰阶（保色相判据失效 = 本用例 PASS）。
⚠️ 若该注入让 TSL 类型不匹配（标量位乘 vec3），改成在 gain 处返回 vec3 并让 shade 乘它 —— 
实施者按真实报错调整注入形式，**不得放宽断言**。

- [ ] **Step 4: 跑负向② 确认 PASS**

Run: `MC_PORT=8192 npx playwright test tests/cloud-softness.spec.mjs -g "负向④"`
Expected: PASS，打印的 R−B 偏移显著。

---

### Task 5: 消费方回归 + 热路径门禁 + 文档

**Files:**
- Modify: `docs/roadmap.md`（v3.51 行）
- Modify: `docs/pitfalls.md`（仅当实测踩到新坑）

- [ ] **Step 1: 消费方 spec（grep 出的最小充分集）**

Run: `MC_PORT=8192 npx playwright test tests/cloud-softness.spec.mjs tests/wet-surface.spec.mjs tests/normal-style.spec.mjs tests/crosshair.spec.mjs tests/hemisphere-ambient.spec.mjs tests/sun-directional.spec.mjs tests/sun-shadow.spec.mjs`
Expected: 全绿；**已知既有 flaky**（crosshair 极亮天区时序型、wet-surface 地面净效应、moonlight 世界未收敛）
若出现，用 `uCloudFaceContrast=0` 的单变量 A/B 定性，**不改阈值**，按 AGENTS.md 只报告。

- [ ] **Step 2: 热路径门禁**

Run: `npm run bench -- --check`（后台跑，~5min）
Expected: exit 0；`docs/m3-baseline.*` 未被改写（若被改写要 `git checkout` 恢复 —— 那是冻结基线）。

- [ ] **Step 3: 写 roadmap v3.51 行**

内容：用户原话与两张截图路径、根因恒等式、三个 gain 与实测逐档表、独立 uniform 的理由、
1.38 的安全上界扫描、验证证据（各命令的实际输出）、已知代价。

- [ ] **Step 4: 最终静态门**

Run: `npm run check`
Expected: exit 0。

- [ ] **Step 5: Commit（等用户明确指令后执行）**

```bash
git add src/render/cloud-shade.js src/render/materials.js src/tests/test-cloud-shade.js \
  tests/cloud-softness.spec.mjs docs/roadmap.md \
  docs/superpowers/specs/2026-11-27-cloud-side-face-contrast-design.md \
  docs/superpowers/plans/2026-11-27-cloud-side-face-contrast.md
git commit -m "feat: 云侧面提亮、顶底压暗，面间明暗分离"
```