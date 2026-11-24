# 水汪倒影镜面高度修复（v3.39）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（用户 2026-11-19 已定 Native 内联 + 新分支，不用 worktree）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让地面水汪的镜面反射几何正确 —— 倒影底边与实物底边严格衔接（不再夹一条天空），且水汪里不再出现地下岩层残影；台阶/半砖等高于镜面的面上的水汪同样映得对。

**Architecture:** 给地面水汪新建**独立 reflector**（自己的 target + RT），镜面高度每帧跟随玩家脚下地面顶面；采样口径从 `screenUV` 换成**逐片元投影**（片元世界坐标关于镜面翻折后用主相机投影）。ocean 的海面 reflector 与它的全部常量/冻结断言**一字不动**。两条 pass 各自套 multi-draw 守卫与替身材质 swap。

**Tech Stack:** three r185.1 TSL（WebGPU 唯一后端）、Node 内置 test runner（`tools/run-unit-node.mjs`）、Playwright + pngjs 真实 GPU 像素。

**Spec:** 无独立设计稿。本计划直接依据 2026-11-24 的诊断实测（见下「实测依据」）与用户两项裁定。相关历史文档：`docs/retro-2026-11-23-puddle-mirror-reflection.md`、`docs/roadmap.md` v3.33 行。

**诊断会话全程记录:** [`docs/pi-session-2026-11-24T10-15-45-677Z_01a20d0d-eb0d-75c8-bee9-d7c0c3cd5c8c.html`](../../pi-session-2026-11-24T10-15-45-677Z_01a20d0d-eb0d-75c8-bee9-d7c0c3cd5c8c.html)

> 该 HTML 是本轮诊断的完整会话导出（用户提问、46 组探针的源码与实际读数、每次结论修正的推理过程、两张用户 bug 截图的判读）。
> **执行者遇到「为什么这样定」的疑问时查它**，尤其是：
> - 为什么 `screenUV` 口径只对落在镜面上的片元正确（P/AX 探针的原始读数与截图对比）；
> - 为什么「残影不随世界换色更新」是**测量假象**而非第二个 bug（X→AG→AU→AW 的推翻链，含 k 分布逐像素核对）；
> - 为什么 Task 1 是前置验证而非直接实施（AY 四种 UV 口径全失败、AZ 证明镜面抬升本身生效的对照）。
>
> ⚠️ 文件 38.6 MiB 且被 `.gitignore` 的 `pi-session-*.html` 规则排除，**不入库** —— 只在本地可读。
> 计划的「实测依据」表已把关键读数摘录进来，脱离该 HTML 也能执行；它是溯源材料，不是必读前置。

---

## 实测依据（诊断已完成，本计划的事实基础）

全部为真实 GPU 像素 / 真实 mesher 实测，不是推理。探针存档 `tests/tmp-puddle-*.spec.mjs`（gitignore）与 `/tmp/puddle-probe/`；
每条读数对应的探针源码、命令与实际输出见[诊断会话记录](../../pi-session-2026-11-24T10-15-45-677Z_01a20d0d-eb0d-75c8-bee9-d7c0c3cd5c8c.html)。

| 编号 | 事实 | 读数 |
|---|---|---|
| P | **镜面上的点**在主相机与镜像相机下屏幕行**逐位相同** | 6/6 点（z=−73/−75/−77.2/−78/−80/−84，dy=0） |
| P | 镜面**之上**的点在镜像相机里行号更大（倒影往下延伸） | z=−78：dy=0 → 0.3749/0.3749；dy=1.6 → main 0.1727 / vc 0.5376 |
| S | 高地机位（地面顶面 y=6，镜面 −1.5）地面与台阶在镜像相机里**出画** | 地面近处 vcFy=1.8025、台阶底 vcFy=1.137（>1） |
| S | 镜面抬到 6 后，台阶底镜像行 = 实物行，世界间隙归零 | 0.4304 = 0.4304；间隙 15 格 → 0 格 |
| — | 用户机位间隙 = `2×(地面顶面 − 镜面高)` | `2×(−1−(−1.5)) = 1 格` ⇒ 与用户「差一个方块高度」吻合 |
| AT | RT 暗灰残影像素的世界来源 | 60/60 命中 **stone，y=−2 或 −1，水平距相机 37~60 格**（远处地表以下岩层露头） |
| — | 斜裁剪面只裁 `y < 镜面高` | 镜面 −1.5 时，−1.5 到地面 6 之间 7.5 格岩层**合法进入 RT** |
| — | 镜像相机被埋在地下 | `y = 2×(−1.5) − 7.62 = −10.62` |
| mesher | 实心岩层内部**没有面**（meshing 阶段就剔，不是渲染期背面剔除） | 18³ 全实心 → **0 顶点**（24096 面全剔）；挖 4³ 空腔 → **384 顶点** = 6面×16格×4顶点 |
| AM | 残影来自反射 pass 的体素通道 | 只隐藏反射 pass 的 opaque+cutout ⇒ 水汪灰石占比 0.86% → **0.00%** |
| AW | 采样链**同步正常**（无「陈旧 RT」bug） | 同轮连拍反解 `on = mix(off, RT, k)` 残差：换色前 4.09 / 换色后 4.02 |
| AX | **只抬镜面不够**：高于镜面 1 格的面上的水汪**完全没有倒影** | 镜面 y=6：标记在地面 y=6 有倒影；标记在高台顶面 y=7 倒影为空 |
| — | `screenUV` 口径只对落在镜面上的片元正确；高差 1 格时内容水平错位 `d/(eye−1) ≈ 1.61×d` | d=2 格 → ≈98px；d=5 → ≈39px；d=12 → ≈16px |

**⚠️ 未闭环项（本计划 Task 1 必须先解决）**：逐片元投影的 UV 翻转口径**尚未验通**。探针 AY 在正确镜面（y=6，`markBase.vcFy=0.5115` 在画内）下试了 `p_none / p_x / p_y / p_xy` 四种组合，**全部无倒影**；而同期 AX 证明标记放地面时有倒影。这说明「RT 里到底有没有那个高台上的标记」还没确证 —— 可能是反射 pass 没画它（裁剪/剔除/守卫），而不是采样口径错。**Task 1 就是先把这件事查清并定下口径，之后的一切才成立。**

**⚠️ 已推翻的旧结论（不要据此设计）**：诊断中途曾报「残影不随世界换色更新，疑似替身材质/实例数据陈旧」。AW 同轮连拍 + 逐像素 k 核对已推翻它 —— 那是把大量 `k≈0` 的像素平均进去造成的测量假象。**不存在第二个 bug**，两个症状同一根因。

---

## Global Constraints

- 所有解释、说明、注释用中文（项目 AGENTS.md）。
- **红线 1**：CPU 纯函数与 TSL 公式逐项同构，常量只有一份权威。新增常量放 `src/render/puddle-reflect-config.js`（three-free）。
- **红线 3/8**：重计算不在主线程做加法；`puddle-reflect-config.js` 不 import three（Node 单测直接读）。
- **红线 4/5**：不新建地面 mesh；水汪效果仍是本体材质的可开关分支；发布粒度不变。
- **ocean 一字不动**：`WATER_LEVEL_OFFSET = -1.5`、`REFLECT_STRENGTH = 0.8`、`REFLECT_TINT = 0.4`、`REFLECT_GRAZE = 0.15`、`REFLECT_HEIGHT_FULL/ZERO = 16/48`、`REFLECT_DISTORT = 0.024` 全部不改。`tests/water-visual.spec.mjs` 的冻结色阶带（morning/noon ∈ (108,124)、dusk ∈ (80,106)、night ∈ (70,100)）**不得放宽**。
- 新 reflector 复用既有尺寸/节流口径：`REFLECT_RESOLUTION_SCALE = 0.7`、`REFLECT_MIP_LEVEL = 2`、`REFLECT_REFRESH_EVERY = 2`（从 `water-reflect-config.js` import，不写第二份字面量）。
- **不动**：`WET_REFL_MAX=0.55`、`WET_PUDDLE_MIRROR=0.44`、`WET_PUDDLE_FROM/TO=0.52/0.76`、`WET_PUDDLE_SCALE=0.32`、`PUDDLE_REFLECT_STRENGTH=0.55`、`PUDDLE_REFLECT_EDGE_FADE=0.06`、材质分类表、方块顺序、mesher。
- TSL 七条口径（`wet-surface.js` 文件头）：节点不与裸数字算术（用 `float()`）、常量色显式拆 `.r/.g/.b`、多层 mix 不链式、径向量在片元算、不用 `.toVar()/.assign()`、反向 smoothstep 用 `oneMinus`、噪声用 `mx_noise_float`。
- **零回归锚点必须保留**：`uWet=0`（第一级）、`uWetPuddleRefl=0`（第二级）、`uPuddleReflect=0`（第三级）三级都必须逐位回归。
- 两条反射 pass **各自**套 `beginReflectGuard()/endReflectGuard()` + `beginReflectMaterialSwap()`，`finally` 里恢复（v3.17 天空撕裂 / v3.30d 双 pass 覆写的既有教训）。
- 反射 pass 必须在主 `renderer.render()` **之前**跑（载荷性约束，`ocean.js` 反射段）。
- 测试命令**不接管道**（退出码会被末端工具替换）。> 1 分钟的命令用 `run_in_background`。
- worktree 里跑浏览器验证必须 `MC_PORT=<自己的端口>` 两侧同源并核对端口归属。
- 提交等明确指令；本计划不含 commit 步骤。

## Review Focus

1. **海面倒影被地面镜面污染** ⇒ 站在陆地上时海面按陆地高度反射，`water-visual` 冻结色阶红。Task 3 的 Tier 4 用例钉「地面 reflector 开/关时海面区逐位不动」。
2. **两条 pass 互相覆写 BatchedMesh 索引表** ⇒ 主视锥内几何整帧不绘制（天空撕成黑多边形）。Task 3 钉「天空区近黑像素占比与基线逐位相同」。
3. **镜面高度跟随抖动** ⇒ 玩家走台阶/跳跃时镜面每帧跳变，倒影闪烁。Task 2 钉平滑跟随与瞬移吸附的纯函数边界。
4. **未加载列 / 世界底** ⇒ `getBlockId` 对缺失列返回 0、对 `y<WORLD_MIN_Y` 返回 bedrock，扫描会一路命中世界底 ⇒ 镜面掉到 −32。Task 2 钉「扫不到时回落」与下界钳制。
5. **飞行/水下/棚下** ⇒ 飞到高空、潜到水下、躲在屋顶下时镜面取值无意义，倒影应淡出或关闭而不是映出错位内容。Task 2 钉这三种态的回落值，Task 4 钉像素淡出。
6. **逐片元投影的除零** ⇒ 翻折点落在相机平面上时 `clip.w = 0` ⇒ uv 为 NaN ⇒ 整片材质不上屏（本仓已记 `NaN.0` 教训）。Task 1 钉「w≤ε 时回落 screenUV」。

---

### Task 1: 前置验证 —— 确证 RT 内容与逐片元投影口径（**只写探针，不改产品代码**）

**Files:**
- Create: `tests/tmp-puddle-verify-probe.spec.mjs`（gitignore，不提交）
- 产出: `/tmp/puddle-probe/VERIFY.md`（结论备忘，供后续任务引用；不入库）

**Interfaces:**
- Produces（**后续任务的输入，不是代码接口**）：
  - `UV_MODE`: `'p_none' | 'p_x' | 'p_y' | 'p_xy'` 中**实测正确**的那一个
  - `RT_HAS_UPPER_MARKER`: boolean —— 镜面抬到地面后，RT 里是否画出了高于镜面的物体
  - 若 `RT_HAS_UPPER_MARKER === false`：根因归类（裁剪面 / 背面剔除 / multi-draw 守卫 / 替身材质）与对应修法要点

- [ ] **Step 1: 写探针 —— 先查 RT 里有没有高台上的标记**

夹具：平整地面顶面 y=6（方块层 y=5）+ 前方 z−20..−6 整片 y=6 高台（顶面 y=7）；镜面 target 摘出 plane 后置世界 y=6；品红标记底 y=7 立在高台上（z−9）。
**时序铁律**（AY 首版栽在这）：每次渲染前显式 `t.position.set(...)` → `t.updateMatrixWorld(true)` → `g.scene.updateMatrixWorld(true)` → `g.ocean.update()` → `reflectScheduler.invalidate()` → `_renderWaterReflection()`。
拍两张：主画面、RT 全屏（`screenUV.flipX()` + `levelNode=float(0)`）。统计品红像素数（判据 `r−g>22 && b−g>8`）。
对照三组：标记底 y=7（高台）/ y=6（地面）/ y=7 但 z−7（高台近处）。

- [ ] **Step 2: 跑探针，读实际值**

Run: `MC_ALLOW_TMP=1 MC_PORT=8097 npx playwright test tests/tmp-puddle-verify-probe.spec.mjs --reporter=list`
Expected: 打印三组的 `主画面品红 / RT品红`。
**分支判据**：
- 若高台组 `RT品红 > 0` ⇒ RT 有标记，问题在采样口径 ⇒ 进 Step 3。
- 若高台组 `RT品红 === 0` 而地面组 `> 0` ⇒ **反射 pass 没画高于镜面的物体** ⇒ 进 Step 4。

- [ ] **Step 3: （RT 有标记时）四种翻转口径单变量扫描**

用 `page.route` 注入 `puddle-reflect.js`，把 `const uv = screenUV.flipX()` 换成按 URL `?uvmode=` 选：
`__base = (proj × view × vec4(wp.x, 2M−wp.y, wp.z, 1)).xyz / w`，再 `×0.5+0.5`；四种组合分别对 x/y 取 `oneMinus()`。
**注入后必须读回源码确认落地**（`fetch('/src/render/puddle-reflect.js')` 检查含 `uvmode`），否则注入静默失效。
判据：高台顶面水汪带里出现品红倒影，且其屏幕行区间与 `virtualCamera.project(标记底/顶)` 预测一致（±0.02）。
把胜出的 `UV_MODE` 与读数写进 `/tmp/puddle-probe/VERIFY.md`。

- [ ] **Step 4: （RT 无标记时）定位反射 pass 为何不画它**

四个单变量，各自独立跑：
① 把 `reflect.target` 的 rotation 显式设 `(-π/2, 0, 0)` 并核对 `matrixWorld` 法线方向（reflector 用 `target` 的局部 +Z 作镜面法线）；
② 读 `virtualCamera.projectionMatrix` 第三行算出的 `clip.w` 在标记底/顶世界 y 上的值（>0 才保留）；
③ 只隐藏反射 pass 的 opaque/cutout（`page.route` 注入 `render-world.js` 的 `beginReflectMaterialSwap`）对照，确认标记是否被守卫/替身影响；
④ 把标记换成 `MeshBasicNodeMaterial` 之外的普通 `MeshBasicMaterial`，排除节点材质在镜像 pass 下的适配问题。
把根因与修法要点写进 `/tmp/puddle-probe/VERIFY.md`。

- [ ] **Step 5: 停下报告，等裁决**

若 Step 4 表明「逐片元投影」路线在本仓 WebGPU 下不成立（例如裁剪面语义与预期不符且无法绕开），**停止实施并报告**，给出退路（只抬镜面 + 高度门，台阶顶面不映）。不得自行放宽判据或改口径硬凑。

---

### Task 2: CPU 同构层 —— 镜面高度跟随（three-free 纯函数）

**Files:**
- Create: `src/render/puddle-reflect-config.js`
- Create: `src/tests/test-puddle-reflect-height.js`
- Modify: `src/tests/index.html`（注册新单测）
- Modify: `tools/test-tiers.mjs`（Node 轻档白名单追加 `test-puddle-reflect-height.js`）

**Interfaces:**
- Consumes: `WORLD_MIN_Y`（`src/voxel/constants.js`）；`registry.solidTable` / `hollowOccluderTable`；`world.getBlockId`
- Produces:
  - `PUDDLE_MIRROR_FOLLOW_RATE: number` = 12（每秒跟随速率，与 v3.30d 地面反射同口径）
  - `PUDDLE_MIRROR_SNAP_DIST: number` = 8（瞬移吸附阈值，格）
  - `PUDDLE_MIRROR_SCAN_DEPTH: number` = 48（向下扫描上限，与 `rainShelterY` 同口径）
  - `PUDDLE_MIRROR_EPS: number` = 0.05（片元与镜面共面判定容差，格）
  - `puddleGroundTopY(world, registry, x, z, fromY, searchDepth?): number | null` —— 脚下地面顶面世界 y；扫不到返回 `null`
  - `puddleMirrorY(prev, target, dt, rate?): number` —— 平滑跟随；`|target−prev| > SNAP_DIST` 时直接吸附；`target` 非有限数时返回 `prev`
  - `puddleMirrorFade(cameraY, mirrorY, flying, underwater): number` —— 0~1 强度门；飞行/水下/相机不高于镜面时返回 0

- [ ] **Step 1: 写失败测试**

`src/tests/test-puddle-reflect-height.js`，用 `createRegistry()` + 真实 `ChunkColumn`/`WorldData` 造列（照抄 `test-water-surface.js` 的夹具手法，**不拿常量互推**）。断言：
① `puddleGroundTopY` 在「方块层 y=5 实心、y=6 空气」时返回 **6**（顶面 = 方块 y+1）；
② 台阶（`sand_slab`，`solidTable=1`、`hollowOccluderTable=0`）在 y=6 时返回 **7**；
③ 云（`cloud`）与树叶族（`hollowOccluderTable=1`）**不算地面**（与 `blocksRain` 同口径，避免镜面爬到云上）；
④ 未加载列（全 air）返回 `null`，**不得**一路扫到 `WORLD_MIN_Y`（下界钳制）；
⑤ x/z 带 `.5` 小数时结果与取整一致（`getBlockId` 小数下标会读成 air，本仓已记）；
⑥ `puddleMirrorY`：`dt=1/60`、`rate=12` 时单帧移动量 = `(target−prev)×min(1, rate×dt)`；`|Δ|>8` 直接等于 target；`target=NaN` 返回 prev；
⑦ `puddleMirrorFade`：`flying=true` → 0；`underwater=true` → 0；`cameraY <= mirrorY` → 0；正常站姿（cameraY = mirrorY+1.62）→ 1；
⑧ 四个常量值与上表逐字相同。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-puddle-reflect-height.js`
Expected: FAIL —— 模块不存在（Cannot find module）。

- [ ] **Step 3: 实现四个常量与三个纯函数**

`puddleGroundTopY` 的扫描判据**复用 `blocksRain` 的语义**（实心 ∧ 非镂空遮挡体 ∧ 非 cloud），从 `rain-shelter.js` import 该函数而不是重写一份（红线 1）；`fromY` 取 `Math.floor(fromY)`，下界 `Math.max(WORLD_MIN_Y, start − searchDepth)`，命中返回 `y+1`。
`puddleMirrorY` / `puddleMirrorFade` 按 Step 1 的公式实现，不引入 three。

- [ ] **Step 4: 注册并跑测试确认 GREEN**

在 `src/tests/index.html` 逐条 import 段追加新文件；`tools/test-tiers.mjs` 的 Node 轻档白名单追加。
Run: `node tools/run-unit-node.mjs --only=test-puddle-reflect-height.js`
Expected: PASS（8 组全绿）
Run: `npm run check`
Expected: exit 0（`[测试注册]` 与 `[测试分档]` 双向钉住通过）

---

### Task 3: 独立地面 reflector + 逐片元投影采样

**Files:**
- Create: `src/render/puddle-reflector.js`
- Modify: `src/render/puddle-reflect.js`（采样口径换成 Task 1 定的 `UV_MODE`）
- Modify: `src/render/render-world.js`（`beginReflectMaterialSwap` 支持第二条 pass 的替身；`reflectTexture` 入参改指地面 RT）
- Modify: `src/core/game.js`（装配地面 reflector；帧循环里两条 pass 各自守卫）
- Test: `tests/puddle-reflect.spec.mjs`（重写内容级判据，见 Step 1）

**Interfaces:**
- Consumes: Task 1 的 `UV_MODE`；Task 2 的 `puddleGroundTopY` / `puddleMirrorY` / `puddleMirrorFade` / `PUDDLE_MIRROR_EPS`；`REFLECT_RESOLUTION_SCALE` / `REFLECT_MIP_LEVEL` / `REFLECT_REFRESH_EVERY`（`water-reflect-config.js`）
- Produces:
  - `setupPuddleReflector(scene): { target: THREE.Object3D, reflect: ReflectorBaseNode, reflectTexture: ReflectorNode, uMirrorY: UniformNode<number>, renderReflection(camera, hidden): void, syncReflectTexture(): void, setMirrorY(y: number): void, dispose(): void }`
  - `createPuddleReflectNode({ reflectTexture, puddleW, uStrength, uMirrorY })` —— 新增 `uMirrorY` 入参（既有三个不变）

- [ ] **Step 1: 重写 Tier 4 判据（先红）**

`tests/puddle-reflect.spec.mjs` 现有「亮塔下方变化 ≫ 暗塔下方」判据**已被 roadmap v3.33 证伪**（测的是水汪压暗的自然差异）。替换为三条：
① **内容搬移**：把塔身贴图色改掉（`editor.setBlocks` 换方块），水汪区读数必须跟着变（|Δ| > 20），而塔区变化必须显著更大（夹具前提）；
② **接缝**：贴地标记（底 y = 地面顶面）的倒影顶边屏幕行与实物底边屏幕行差 **< 0.01**（用 `camera.project` 算预测值，不写死屏幕坐标）；
③ **高台**：高于镜面 1 格的台面上的标记，其倒影存在且屏幕行区间与 `virtualCamera.project` 预测一致（±0.02）。
夹具时序照抄既有 `buildTwinTowers`：`setBlocks` → `waitWorldStable`（循环仍跑）→ 才停循环。

- [ ] **Step 2: 跑测试确认 RED**

Run: `MC_PORT=8097 npx playwright test tests/puddle-reflect.spec.mjs --reporter=list`
Expected: FAIL —— ②③ 不成立（现状镜面 −1.5，接缝差 ≈0.27 屏高、高台无倒影）

- [ ] **Step 3: 实现独立 reflector**

`src/render/puddle-reflector.js`：`reflector({ resolutionScale: REFLECT_RESOLUTION_SCALE, bounces: false, generateMipmaps: true })`；`target` **直接挂 scene**（不挂 ocean.plane，否则被 `ocean.update` 重置 —— 已实测）；`target.rotation.x = -π/2`；`updateBeforeType = NONE` + 手动 `updateBefore`（与 ocean 同手法，避开 transparent 队列末尾触发导致的天空撕裂）。
`setMirrorY(y)` 写 `target.position.y` 与 `uMirrorY.value`，并 `target.updateMatrixWorld(true)`。
`renderReflection` 与 ocean 同结构：临时隐身 `hidden` → `reflectUpdate({scene, camera, renderer, material})` → `finally` 恢复。`material` 传一个**不参与主画面的占位材质**（reflector 内部要置 `visible=false`；不得传 ocean 的水面材质）。

- [ ] **Step 4: 换采样口径**

`puddle-reflect.js` 的 `createPuddleReflectNode` 按 Task 1 定的 `UV_MODE` 实现逐片元投影：`__mirrored = vec4(wp.x, uMirrorY.mul(float(2)).sub(wp.y), wp.z, float(1))` → `cameraProjectionMatrix.mul(cameraViewMatrix.mul(__mirrored))` → `.xyz.div(w)` → `×0.5+0.5` → 按 `UV_MODE` 翻转。
**除零护栏**（Review Focus 6）：`w` 的绝对值小于 `float(1e-4)` 时用 `select` 回落到 `screenUV.flipX()`，不得产生 NaN。
边缘淡出与 `k` 的公式**一字不动**（`PUDDLE_REFLECT_STRENGTH` / `EDGE_FADE` 保持）。

- [ ] **Step 5: 装配两条 pass**

`game.js`：`this.puddleReflector = setupPuddleReflector(this.scene)`，`renderWorld` 的 `reflectTexture` 入参改传 `this.puddleReflector.reflectTexture`（ocean 的 clone 不再给体素材质）。
`_renderWaterReflection()` 里在既有 ocean pass **之后**追加地面 pass：各自 `beginReflectGuard()` → `beginReflectMaterialSwap()` → `renderReflection` → `syncReflectTexture()` → `finally { swap(); endReflectGuard(); }`。
地面 pass 的门控用 Task 2 的 `puddleMirrorFade`；镜面高度每帧由 `puddleGroundTopY(world, registry, pp.x, pp.z, pp.y)` → `puddleMirrorY(prev, target, realDt)` 得出后 `setMirrorY`。
`beginReflectMaterialSwap` 需能同时屏蔽**两条** RT 的采样（替身材质不传任何 reflectTexture，现有实现已满足；核对 `render-world.js` 的 `reflectTexture` 入参来源已改）。

- [ ] **Step 6: 跑测试确认 GREEN**

Run: `MC_PORT=8097 npx playwright test tests/puddle-reflect.spec.mjs --reporter=list`
Expected: PASS（三条判据 + 既有零回归/负向用例）

- [ ] **Step 7: 海面零污染 + 天空不撕碎（Review Focus 1/2）**

在同一 spec 追加两条：
① 地面 reflector 开/关（`uPuddleReflect` 1↔0）时，**海面区**像素逐字节相同（`diffBytes === 0`）；
② 天空区近黑像素占比与「只有一条 ocean pass」基线**逐位相同**。
Run: `MC_PORT=8097 npx playwright test tests/puddle-reflect.spec.mjs tests/water-reflect.spec.mjs tests/water-visual.spec.mjs --reporter=list`
Expected: 全 PASS，`water-visual` 冻结色阶逐位保持（morning/noon ∈ (108,124) 等）

---

### Task 4: 边界态与负向验证

**Files:**
- Modify: `tests/puddle-reflect.spec.mjs`（追加）
- Modify: `src/render/puddle-reflect.js`（若 Step 1 暴露护栏缺口）

**Interfaces:**
- Consumes: Task 2 的 `puddleMirrorFade`；Task 3 的 `setMirrorY` / `uMirrorY`
- Produces: 无新接口

- [ ] **Step 1: 写边界态用例（先红）**

四条，对应 Review Focus 3/4/5：
① **走台阶不闪**：玩家从地面走上 1 格台阶，连续 30 帧采样水汪区，逐帧变化量的 p95 必须小于「瞬移吸附」时的单帧变化量（平滑跟随生效）；
② **瞬移吸附**：`_teleportTo` 到 100 格外，下一帧镜面必须已等于新地面顶面（`|Δ|>8` 吸附）；
③ **未加载列**：传送到未加载区，镜面**不得**等于 `WORLD_MIN_Y+1`（−31），应回落上一帧值且 `puddleMirrorFade` 给出的强度不产生错位倒影；
④ **飞行/水下**：`physics.flying=true` 或相机在水下时，水汪区与 `uPuddleReflect=0` 逐字节相同。

- [ ] **Step 2: 跑测试确认 RED**

Run: `MC_PORT=8097 npx playwright test tests/puddle-reflect.spec.mjs --reporter=list`
Expected: 新增四条中至少 ①③ FAIL（平滑与回落尚未接线到装配层）

- [ ] **Step 3: 补齐装配层接线**

`game.js` 的镜面更新处把 `physics.flying` / `physics.inWater` 传进 `puddleMirrorFade`，并把 fade 乘进地面 pass 的强度门（fade=0 时**整条 pass 不跑**，与 ocean 的高度门同口径 —— 省成本而非跑了再乘 0）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `MC_PORT=8097 npx playwright test tests/puddle-reflect.spec.mjs --reporter=list`
Expected: 全 PASS

- [ ] **Step 5: 负向验证（三条，注入后必须读回源码确认落地）**

用 `page.route` 注入，**还原用 `cp` 副本，不用 `git checkout`**：
① 把 `uMirrorY` 恒设 `float(-1.5)`（回到旧镜面）⇒ 接缝判据②必须 FAIL；
② 去掉除零护栏 ⇒ 必须出现 GPU 验证错误或 NaN（不得静默全绿）；
③ 把 `puddleGroundTopY` 的镂空/cloud 排除去掉 ⇒ 云上台面被当地面，Task 2 的③必须 FAIL。
每条注入后跑对应用例，确认真 FAIL 再还原。

- [ ] **Step 6: 最小充分集回归**

Run: `npm run check`
Run: `node tools/run-unit-node.mjs --only=test-puddle-reflect-height.js,test-puddle-reflect.js,test-wet-surface.js,test-water-reflect.js,test-water-reflect-height.js`
Run: `MC_PORT=8097 npx playwright test tests/puddle-reflect.spec.mjs tests/wet-surface.spec.mjs tests/water-reflect.spec.mjs tests/water-visual.spec.mjs tests/storm-lighting.spec.mjs tests/storm-underwater.spec.mjs --reporter=list`
Expected: 全绿。**不跑 `npm test`**（本改动不属全局基础设施，AGENTS.md 禁止）。
若 `water-visual` 的 morning 色阶或 fps 出现单次红：按既有 flaky 纪律用**交替对照**定性（HEAD 副本 + 本分支各 2~3 轮交错），**不改阈值**。

- [ ] **Step 7: 性能核对**

Run: `MC_PORT=8097 npx playwright test tests/render-terrain.spec.mjs --reporter=list`
Expected: draw call / 顶点字节冻结断言保持（新增一条 pass 不改主 pass 的 draw 数）。
新增 pass 的提交耗时用「连续同步 render 压测」量一次（绕开 vsync），记进 roadmap；若增量 > 0.5ms 停下报告。

---

### Task 5: 文档同步

**Files:**
- Modify: `docs/roadmap.md`（新增 v3.39 行）
- Modify: `docs/pitfalls.md`（渲染与 GPU 节追加本轮教训）
- Modify: `docs/retro-2026-11-23-puddle-mirror-reflection.md`（追加「v3.39 已修」段）

- [ ] **Step 1: 写 roadmap v3.39 行**

含：用户原话（两个症状 + 台阶追问）、两项裁定（抬镜面+逐片元投影 / 双 reflector）、实测依据表（本计划「实测依据」节的关键读数）、**已推翻的旧结论**（「残影不刷新」是测量假象）、验证证据（命令 + 实际读数）、新增常量与接口。

- [ ] **Step 2: 写 pitfalls 三条**

① **`screenUV` 采样只对落在镜面上的片元正确**：高差 1 格 ⇒ 内容水平错位 `d/(eye−1)`；判据必须用 `camera.project` 算预测行，写死屏幕坐标会恒真。
② **镜面低于地面时地下岩层合法进入 RT**：斜裁剪面只裁 `y<镜面高`，镜像相机被埋在地下 ⇒ 水汪映出地下剖面。实心岩层内部**没有面**（mesher 实测 0 顶点），所以「看见地下」不是背面剔除而是 meshing 剔除 + 空腔内壁。
③ **「RT 变了主画面没变」先查 k 分布**：把大量 `k≈0` 的像素平均进去会得出「采样链断裂」的假结论；必须同轮连拍 + 逐像素反解 `on=mix(off,RT,k)`。

- [ ] **Step 3: 核对文档与代码一致**

Run: `npm run check`
Expected: exit 0

---

## 自审记录

- **Spec 覆盖**：无独立 spec，两个用户症状 + 台阶追问各有归属 —— 症状 B（接缝）→ Task 3 Step 1②；症状 A（地下残影）→ Task 3 Step 5（裁剪面随镜面升到地面）+ Task 4 Step 5①负向；台阶面 → Task 1（口径确证）+ Task 3 Step 1③。
- **未闭环项显式化**：逐片元投影口径未验通，写成 Task 1 的前置验证 + Step 5 的停止条件，不假装已成立。
- **类型一致**：`puddleGroundTopY` / `puddleMirrorY` / `puddleMirrorFade` / `setMirrorY` / `uMirrorY` 在 Task 2/3/4 中签名一致；`createPuddleReflectNode` 只新增 `uMirrorY` 一个入参。
- **Review Focus 六条**各有归属任务与用例（1/2→Task 3 Step 7；3/4/5→Task 4 Step 1；6→Task 3 Step 4 + Task 4 Step 5②）。
- **比例**：计划以决策与判据为主，代码块只出现在 TSL 公式（签名与测试不能确定的部分）。